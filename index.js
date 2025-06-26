const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const path = require("path");

const app = express();

// --- SESSION AND VIEW ENGINE SETUP ---
app.use(session({
    // This should be a long random string. We will set it in Render's Environment.
    secret: process.env.SESSION_SECRET || 'a-default-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 86400000 } // 24 hours
}));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

// --- S3/R2 CLIENT SETUP ---
// Reads credentials from Environment Variables set in Render
const s3Client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    }
});
const S3_BUCKET = process.env.S3_BUCKET;


// --- AUTHENTICATION SETUP ---
const adminUsername = process.env.ADMIN_USERNAME;
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

const checkAuth = (req, res, next) => {
    if (req.session.userId === adminUsername) {
        res.locals.username = req.session.userId;
        return next();
    }
    res.redirect('/login');
};

// --- HELPER FUNCTIONS ---
function formatFileSize(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes'
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

function getFileIcon(fileName) {
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const iconMap = { 'mp4': 'fas fa-file-video', 'mov': 'fas fa-file-video', 'mkv': 'fas fa-file-video', 'mp3': 'fas fa-file-audio', 'wav': 'fas fa-file-audio', 'jpg': 'fas fa-file-image', 'png': 'fas fa-file-image', 'jpeg': 'fas fa-file-image', 'pdf': 'fas fa-file-pdf', 'doc': 'fas fa-file-word', 'docx': 'fas fa-file-word', 'zip': 'fas fa-file-archive', 'rar': 'fas fa-file-archive', 'txt': 'fas fa-file-alt' };
    return iconMap[ext] || 'fas fa-file';
}

function generateBreadcrumbs(currentPath) {
    const parts = currentPath.split('/').filter(Boolean);
    let cumulativePath = '';
    const breadcrumbs = [{ name: 'Home', path: '/' }];
    parts.forEach(part => {
        cumulativePath += `/${part}`;
        breadcrumbs.push({ name: part, path: cumulativePath });
    });
    return breadcrumbs;
}

// --- ROUTES (ORDER IS VERY IMPORTANT) ---

app.get('/login', (req, res) => { res.render('login', { error: null }); });

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (username === adminUsername && await bcrypt.compare(password, adminPasswordHash)) {
            req.session.userId = username;
            res.redirect('/');
        } else {
            res.render('login', { error: 'Invalid username or password.' });
        }
    } catch (e) { res.render('login', { error: 'An error occurred during login.' }); }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) { return res.redirect('/'); }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/stream/:key(*)', checkAuth, async (req, res) => {
    const { key } = req.params;
    try {
        const headCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
        const { ContentLength, ContentType } = await s3Client.send(headCommand);
        const rangeHeader = req.headers.range;
        if (rangeHeader) {
            const [startStr, endStr] = rangeHeader.replace(/bytes=/, "").split("-");
            const start = parseInt(startStr, 10);
            const end = endStr ? parseInt(endStr, 10) : ContentLength - 1;
            if (isNaN(start) || start >= ContentLength || (endStr && end >= ContentLength)) {
                res.status(416).send("Requested Range Not Satisfiable"); return;
            }
            const chunksize = (end - start) + 1;
            res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${ContentLength}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': ContentType });
            const getObjectRangeCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, Range: `bytes=${start}-${end}` });
            const { Body } = await s3Client.send(getObjectRangeCommand);
            Body.pipe(res);
        } else {
            res.writeHead(200, { 'Content-Length': ContentLength, 'Content-Type': ContentType });
            const getObjectCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
            const { Body } = await s3Client.send(getObjectCommand);
            Body.pipe(res);
        }
    } catch (error) { res.status(404).send("File not found."); }
});

app.get('/download/:key(*)', checkAuth, async (req, res) => {
    const { key } = req.params;
    try {
        const getObjectCommand = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
        const { Body, ContentLength, ContentType } = await s3Client.send(getObjectCommand);
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);
        res.setHeader('Content-Type', ContentType);
        res.setHeader('Content-Length', ContentLength);
        Body.pipe(res);
    } catch (error) { res.status(404).send("File not found."); }
});

app.use(checkAuth, async (req, res) => {
    const currentPath = req.path.startsWith('/') ? req.path.substring(1) : req.path;
    try {
        const listCommand = new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: currentPath ? currentPath + '/' : '', Delimiter: '/' });
        const listResult = await s3Client.send(listCommand);
        const folders = (listResult.CommonPrefixes || []).map(p => ({ name: path.basename(p.Prefix), fullPath: p.Prefix.slice(0, -1) }));
        const files = (listResult.Contents || []).filter(obj => obj.Key !== listResult.Prefix).map(obj => {
            const isVideo = ['mp4', 'mkv', 'webm', 'mov'].includes(path.extname(obj.Key).slice(1).toLowerCase());
            return { name: path.basename(obj.Key), fullPath: obj.Key, size: formatFileSize(obj.Size), lastModified: obj.LastModified, link: isVideo ? `/stream/${obj.Key}` : `/download/${obj.Key}` };
        });
        let parentPath = '/';
        if (currentPath) {
            const pathParts = currentPath.split('/');
            pathParts.pop();
            parentPath = '/' + pathParts.join('/');
            if (parentPath === '//') parentPath = '/';
        }
        res.render('files', { folders, files, currentPath, parentPath, helpers: { formatFileSize, getFileIcon, generateBreadcrumbs } });
    } catch (error) { res.status(500).send("Error listing files."); }
});

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
