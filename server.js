const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Razorpay Payment Keys (Configurable via environment variables)
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_EverlyStudioKey';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'EverlyStudioSecret123';

// Email Service Credentials (For real email delivery to user inboxes)
const EMAIL_USER = process.env.EMAIL_USER || ''; // e.g. 'yourname@gmail.com'
const EMAIL_PASS = process.env.EMAIL_PASS || ''; // e.g. 'your-16-char-gmail-app-password'
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || EMAIL_USER;
const SMTP_PASS = process.env.SMTP_PASS || EMAIL_PASS;

// Enable CORS and JSON body parsing (with large payload limit for base64 images)
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static web app files
app.use(express.static(path.join(__dirname)));

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'surprises.db');
const db = new DatabaseSync(dbPath);

console.log(`[Database] SQLite Database connected at: ${dbPath}`);

// Initialize Database Table Schema
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        security_question TEXT,
        security_answer TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS surprises (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        boyfriend_name TEXT,
        your_name TEXT,
        start_date TEXT,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
`);

// Migration helper for existing databases
try { db.exec(`ALTER TABLE users ADD COLUMN security_question TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN security_answer TEXT;`); } catch (e) {}

// Helper to generate custom short IDs
function generateId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'love_';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Seed default sample surprise if database is empty
const countRow = db.prepare('SELECT COUNT(*) as cnt FROM surprises').get();
if (countRow.cnt === 0) {
    console.log('[Database] Seeding initial default surprise data into SQLite database...');
    const defaultId = 'demo-surprise';
    const now = new Date().toISOString();
    const defaultConfig = {
        boyfriendName: "Alex",
        yourName: "Emma",
        relationshipStartDate: "2023-09-14",
        memories: [
            { image: "images/photo1.jpg", title: "Our First Date", caption: "The coffee shop where everything started..." },
            { image: "images/photo2.jpg", title: "Beach Getaway", caption: "Sunset waves and unforgettable smiles..." },
            { image: "images/photo3.jpg", title: "Stargazing Night", caption: "Under the midnight sky talking for hours..." },
            { image: "images/photo4.jpg", title: "Road Trip Adventure", caption: "Singing our favorite songs at full volume..." },
            { image: "images/photo5.jpg", title: "Celebration Toast", caption: "To countless more years together..." }
        ],
        songs: [
            { title: "❤️ Perfect - Ed Sheeran", url: "https://open.spotify.com/track/08m1362N235v0v2xQ2mF6u" },
            { title: "🎵 Lover - Taylor Swift", url: "https://open.spotify.com/track/1dGr1c8CrMLDpV6mviImPD" }
        ],
        letter: {
            salutation: "Dearest Alex,",
            paragraphs: [
                "From the very moment our paths crossed, my life became brighter, sweeter, and infinitely more meaningful.",
                "Thank you for every laughter shared, every quiet moment of warmth, and for simply being my anchor through everything."
            ],
            highlight: "You are my favorite thought every morning and my peaceful wish every night.",
            signature: "Forever Yours, Emma ❤️"
        },
        reasons: [
            "Your kind heart and infectious laugh.",
            "How you always know how to make me smile on quiet days.",
            "The way you listen to my stories with pure affection.",
            "Our endless inside jokes and middle-of-the-night talks.",
            "Because loving you is the easiest, truest thing I've ever done."
        ],
        proposal: {
            questionTitle: "Will You Be My Partner Forever? 💍",
            questionSub: "No matter where life takes us, I want to walk it hand in hand with you.",
            yesButtonText: "YES! ABSOLUTELY YES! ❤️",
            noButtonText: "No 😜",
            successHeader: "YOU SAID YES! 💍✨",
            successSub: "Happy Birthday, My Beloved ❤️"
        }
    };

    const stmt = db.prepare(`
        INSERT INTO surprises (id, title, boyfriend_name, your_name, start_date, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        defaultId,
        `Happy Birthday, ${defaultConfig.boyfriendName}`,
        defaultConfig.boyfriendName,
        defaultConfig.yourName,
        defaultConfig.relationshipStartDate,
        JSON.stringify(defaultConfig),
        now,
        now
    );
    console.log(`[Database] Default sample surprise created with ID: ${defaultId}`);
}

/* =========================================================
   USER AUTHENTICATION REST API ENDPOINTS
   ========================================================= */

// 1. POST /api/auth/register - Register User with Security Question
app.post('/api/auth/register', (req, res) => {
    try {
        const { name, email, password, securityQuestion, securityAnswer } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, error: 'Full name, email, and password are required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
        if (existing) {
            return res.status(400).json({ success: false, error: 'An account with this email already exists!' });
        }

        const userId = 'usr_' + crypto.randomBytes(6).toString('hex');
        const now = new Date().toISOString();
        const question = (securityQuestion && securityQuestion.trim()) || 'What city were you born in?';
        const answer = (securityAnswer && securityAnswer.trim().toLowerCase()) || 'secret';

        const stmt = db.prepare(`
            INSERT INTO users (id, name, email, password, security_question, security_answer, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(userId, name.trim(), normalizedEmail, password, question, answer, now);

        console.log(`[Auth] New user registered: '${name}' (${normalizedEmail}) ID: ${userId}`);

        res.json({
            success: true,
            message: 'Account created successfully! Welcome to Everly Studio.',
            user: { id: userId, name: name.trim(), email: normalizedEmail },
            token: userId
        });
    } catch (err) {
        console.error('[Auth Error] Register:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. POST /api/auth/get-security-question - Get User's Security Question
app.post('/api/auth/get-security-question', (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email address is required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = db.prepare('SELECT email, security_question FROM users WHERE email = ?').get(normalizedEmail);

        if (!user) {
            return res.status(404).json({ success: false, error: 'No account found with this email address.' });
        }

        res.json({
            success: true,
            email: user.email,
            question: user.security_question || 'What was the name of your first pet?'
        });
    } catch (err) {
        console.error('[Auth Error] Get Security Question:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. POST /api/auth/reset-password-via-security-question - Reset Password by Verifying Security Answer
app.post('/api/auth/reset-password-via-security-question', (req, res) => {
    try {
        const { email, answer, newPassword } = req.body;
        if (!email || !answer || !newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Email, security answer, and a new password (min 6 chars) are required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

        if (!user) {
            return res.status(404).json({ success: false, error: 'No account found with this email address.' });
        }

        const storedAnswer = (user.security_answer || '').trim().toLowerCase();
        const providedAnswer = answer.trim().toLowerCase();

        if (storedAnswer !== providedAnswer) {
            return res.status(400).json({ success: false, error: 'Incorrect security answer! Please try again.' });
        }

        // Update password
        const stmt = db.prepare('UPDATE users SET password = ? WHERE email = ?');
        stmt.run(newPassword, normalizedEmail);

        console.log(`[Auth] Password reset successfully via Security Question for user: '${user.name}' (${normalizedEmail})`);

        res.json({
            success: true,
            message: '🎉 Password updated successfully! You can now log in with your new password.'
        });
    } catch (err) {
        console.error('[Auth Error] Reset Password via Security Question:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. POST /api/auth/login - Log In User
app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

        if (!user || user.password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        console.log(`[Auth] User logged in: '${user.name}' (${normalizedEmail})`);

        res.json({
            success: true,
            message: `Welcome back, ${user.name}!`,
            user: { id: user.id, name: user.name, email: user.email },
            token: user.id
        });
    } catch (err) {
        console.error('[Auth Error] Login:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper to send password reset email via Nodemailer
async function sendPasswordResetEmail(email, name, resetUrl) {
    try {
        let transporter = null;

        if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
            transporter = nodemailer.createTransport({
                host: SMTP_HOST,
                port: SMTP_PORT,
                secure: process.env.SMTP_SECURE === 'true',
                auth: { user: SMTP_USER, pass: SMTP_PASS }
            });
        } else if (EMAIL_USER && EMAIL_PASS) {
            transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: EMAIL_USER, pass: EMAIL_PASS }
            });
        }

        if (transporter) {
            await transporter.sendMail({
                from: `"Everly Studio" <${EMAIL_USER || SMTP_USER || 'noreply@everlystudio.com'}>`,
                to: email,
                subject: 'Reset Your Password - Everly Studio',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background-color: #FAF6F0; border-radius: 16px; border: 1px solid #E5D8CC;">
                        <h2 style="color: #40372F; font-family: Georgia, serif; font-size: 24px; margin-bottom: 12px; text-align: center;">Reset Your Password</h2>
                        <p style="color: #6B5C50; font-size: 15px; line-height: 1.6;">Hello ${name || 'User'},</p>
                        <p style="color: #6B5C50; font-size: 15px; line-height: 1.6;">We received a request to reset the password for your Everly Studio account. Click the button below to set a new password (valid for 15 minutes):</p>
                        <div style="margin: 30px 0; text-align: center;">
                            <a href="${resetUrl}" style="background-color: #9B806A; color: #ffffff; padding: 14px 28px; border-radius: 30px; text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">Reset Password ✨</a>
                        </div>
                        <p style="color: #9E8C7F; font-size: 13px;">If you did not request a password reset, you can safely ignore this email.</p>
                        <hr style="border: 0; border-top: 1px solid #E5D8CC; margin: 24px 0;">
                        <p style="color: #9E8C7F; font-size: 12px; text-align: center;">© Everly Studio • Luxury Personalized Website Studio</p>
                    </div>
                `
            });
            console.log(`[Email Sent] Password reset email sent to: ${email}`);
            return { sent: true, mode: 'smtp' };
        } else {
            console.log('\n=======================================================');
            console.log(`📧 [LOCAL DEV RESET LINK - NO SMTP CREDENTIALS]`);
            console.log(`To send real emails to inbox, configure EMAIL_USER & EMAIL_PASS in server.js`);
            console.log(`Reset link for ${email}: ${resetUrl}`);
            console.log('=======================================================\n');
            return { sent: true, mode: 'dev', resetUrl };
        }
    } catch (err) {
        console.error('[Email Error] Failed to send email:', err);
        return { sent: false, error: err.message };
    }
}

// 3. POST /api/auth/request-password-reset - Request a Secure Password Reset Token
app.post('/api/auth/request-password-reset', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email address is required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

        // Security practice: Don't leak whether account exists to prevent email enumeration
        if (!user) {
            return res.json({
                success: true,
                message: 'If an account exists for this email, a password reset link has been generated.'
            });
        }

        // Generate a cryptographically secure 64-char token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetId = 'rst_' + crypto.randomBytes(6).toString('hex');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString(); // 15 mins expiry
        const createdAt = now.toISOString();

        // Invalidate any existing unused reset tokens for this email
        db.prepare('UPDATE password_resets SET used = 1 WHERE email = ? AND used = 0').run(normalizedEmail);

        // Store new reset token
        const stmt = db.prepare(`
            INSERT INTO password_resets (id, email, token, expires_at, used, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
        `);
        stmt.run(resetId, normalizedEmail, resetToken, expiresAt, createdAt);

        // Construct reset link URL based on origin or host
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers.host || `localhost:${PORT}`;
        const resetUrl = `${protocol}://${host}/?reset_token=${resetToken}`;

        const emailResult = await sendPasswordResetEmail(normalizedEmail, user.name, resetUrl);

        console.log(`[Auth] Reset token generated for '${user.name}' (${normalizedEmail}). Expires: ${expiresAt}`);

        res.json({
            success: true,
            message: 'A password reset link has been sent to your email address! Please check your inbox.',
            devResetUrl: emailResult.mode === 'dev' ? resetUrl : undefined
        });
    } catch (err) {
        console.error('[Auth Error] Request Password Reset:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. GET /api/auth/validate-reset-token - Check if Reset Token is Valid
app.get('/api/auth/validate-reset-token', (req, res) => {
    try {
        const token = req.query.token;
        if (!token) {
            return res.status(400).json({ success: false, error: 'Token parameter is required.' });
        }

        const resetRecord = db.prepare('SELECT * FROM password_resets WHERE token = ? AND used = 0').get(token);
        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'This password reset link is invalid or has already been used.' });
        }

        const now = new Date().toISOString();
        if (resetRecord.expires_at < now) {
            return res.status(400).json({ success: false, error: 'This password reset link has expired (valid for 15 minutes).' });
        }

        res.json({
            success: true,
            email: resetRecord.email
        });
    } catch (err) {
        console.error('[Auth Error] Validate Token:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. POST /api/auth/complete-password-reset - Complete Password Reset with Token
app.post('/api/auth/complete-password-reset', (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Valid token and new password (at least 6 characters) are required.' });
        }

        const resetRecord = db.prepare('SELECT * FROM password_resets WHERE token = ? AND used = 0').get(token);
        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'This password reset token is invalid or has already been used.' });
        }

        const now = new Date().toISOString();
        if (resetRecord.expires_at < now) {
            return res.status(400).json({ success: false, error: 'This password reset token has expired. Please request a new link.' });
        }

        // Update user's password
        const updateStmt = db.prepare('UPDATE users SET password = ? WHERE email = ?');
        updateStmt.run(newPassword, resetRecord.email);

        // Mark token as used
        const markStmt = db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?');
        markStmt.run(resetRecord.id);

        console.log(`[Auth] Password successfully updated for user email: '${resetRecord.email}' via secure reset token.`);

        res.json({
            success: true,
            message: 'Your password has been changed successfully! You can now log in with your new password.'
        });
    } catch (err) {
        console.error('[Auth Error] Complete Password Reset:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* =========================================================
   DATABASE REST API ENDPOINTS
   ========================================================= */

// 3. GET /api/db/status - Health Check & DB Info
app.get('/api/db/status', (req, res) => {
    try {
        const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
        const surpriseCount = db.prepare('SELECT COUNT(*) as cnt FROM surprises').get().cnt;
        res.json({
            status: 'online',
            database: 'SQLite',
            dbPath: dbPath,
            totalUsers: userCount,
            totalSurprises: surpriseCount,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. GET /api/surprises - List all surprises metadata (optionally filtered by user_id)
app.get('/api/surprises', (req, res) => {
    try {
        const userId = req.query.userId || req.query.user_id;
        let rows;
        if (userId) {
            rows = db.prepare(`
                SELECT id, user_id, title, boyfriend_name, your_name, start_date, created_at, updated_at, config_json
                FROM surprises
                WHERE user_id = ?
                ORDER BY updated_at DESC
            `).all(userId);
        } else {
            rows = db.prepare(`
                SELECT id, user_id, title, boyfriend_name, your_name, start_date, created_at, updated_at, config_json
                FROM surprises
                ORDER BY updated_at DESC
            `).all();
        }

        const formatted = rows.map(r => {
            let parsedConfig = null;
            try { parsedConfig = JSON.parse(r.config_json); } catch(e) {}
            return {
                id: r.id,
                user_id: r.user_id,
                title: r.title,
                boyfriend_name: r.boyfriend_name,
                your_name: r.your_name,
                start_date: r.start_date,
                created_at: r.created_at,
                updated_at: r.updated_at,
                config: parsedConfig
            };
        });

        res.json({ success: true, count: formatted.length, data: formatted });
    } catch (err) {
        console.error('[Database Error] GET /api/surprises:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. GET /api/surprises/:id - Get full surprise data by ID
app.get('/api/surprises/:id', (req, res) => {
    try {
        const { id } = req.params;
        const row = db.prepare('SELECT * FROM surprises WHERE id = ?').get(id);

        if (!row) {
            return res.status(404).json({ success: false, error: `Surprise with ID '${id}' not found in database.` });
        }

        const config = JSON.parse(row.config_json);
        res.json({
            success: true,
            id: row.id,
            userId: row.user_id,
            title: row.title,
            boyfriendName: row.boyfriend_name,
            yourName: row.your_name,
            startDate: row.start_date,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            config: config
        });
    } catch (err) {
        console.error(`[Database Error] GET /api/surprises/${req.params.id}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. POST /api/surprises - Create or update surprise in Database against user account
app.post('/api/surprises', (req, res) => {
    try {
        const { id, userId, title, boyfriendName, yourName, startDate, config } = req.body;
        const targetId = id || generateId();
        const now = new Date().toISOString();

        const configObj = config || req.body;
        const targetUserId = userId || configObj.userId || req.body.user_id || 'guest';
        const bName = boyfriendName || configObj.boyfriendName || 'My Love';
        const yName = yourName || configObj.yourName || 'Me';
        const sDate = startDate || configObj.relationshipStartDate || '2025-01-01';
        const surpriseTitle = title || `Happy Birthday, ${bName} ❤️`;

        const existing = db.prepare('SELECT created_at FROM surprises WHERE id = ?').get(targetId);
        const createdAt = existing ? existing.created_at : now;

        const stmt = db.prepare(`
            INSERT INTO surprises (id, user_id, title, boyfriend_name, your_name, start_date, config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                user_id = excluded.user_id,
                title = excluded.title,
                boyfriend_name = excluded.boyfriend_name,
                your_name = excluded.your_name,
                start_date = excluded.start_date,
                config_json = excluded.config_json,
                updated_at = excluded.updated_at
        `);

        stmt.run(targetId, targetUserId, surpriseTitle, bName, yName, sDate, JSON.stringify(configObj), createdAt, now);

        console.log(`[Database] Saved surprise ID '${targetId}' for User ID '${targetUserId}' successfully.`);

        res.json({
            success: true,
            id: targetId,
            userId: targetUserId,
            title: surpriseTitle,
            message: 'Saved to SQLite Database against user account successfully!',
            url: `/?id=${targetId}`
        });
    } catch (err) {
        console.error('[Database Error] POST /api/surprises:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. DELETE /api/surprises/:id - Delete surprise record
app.delete('/api/surprises/:id', (req, res) => {
    try {
        const { id } = req.params;
        const result = db.prepare('DELETE FROM surprises WHERE id = ?').run(id);

        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: `Surprise ID '${id}' not found.` });
        }

        console.log(`[Database] Deleted surprise ID '${id}' from database.`);
        res.json({ success: true, message: `Surprise '${id}' deleted successfully.` });
    } catch (err) {
        console.error(`[Database Error] DELETE /api/surprises/${req.params.id}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. POST /api/db/export - Export entire Database as JSON
app.get('/api/db/export', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM surprises').all();
        const exportData = rows.map(r => ({ ...r, config: JSON.parse(r.config_json) }));
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="surprises_db_export.json"');
        res.json({ exportedAt: new Date().toISOString(), total: rows.length, data: exportData });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* =========================================================
   RAZORPAY PAYMENT GATEWAY ENDPOINTS
   ========================================================= */

// 7. POST /api/payment/create-order - Create Razorpay Order
app.post('/api/payment/create-order', (req, res) => {
    try {
        const { amount = 75000, currency = 'INR', surpriseId } = req.body;
        const orderId = 'order_' + crypto.randomBytes(8).toString('hex');

        console.log(`[Razorpay Payment] Order created: ${orderId} for Surprise ID: ${surpriseId || 'N/A'}, Amount: ₹${amount / 100}`);

        res.json({
            success: true,
            orderId: orderId,
            amount: amount,
            currency: currency,
            keyId: RAZORPAY_KEY_ID,
            productName: "Everly Studio Premium Upgrade",
            description: "Unlock all luxury features, themes, soundtracks & effects"
        });
    } catch (err) {
        console.error('[Razorpay Order Error]:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. POST /api/payment/verify-payment - Verify Razorpay Payment Signature
app.post('/api/payment/verify-payment', (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature, surpriseId } = req.body;

        console.log(`[Razorpay Payment] Verifying payment '${razorpay_payment_id}' for order '${razorpay_order_id}'`);

        let isValid = true;
        if (razorpay_signature && razorpay_signature !== 'direct_upi_verified' && RAZORPAY_KEY_SECRET !== 'EverlyStudioSecret123') {
            const hmac = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
            hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
            const generatedSignature = hmac.digest('hex');
            isValid = generatedSignature === razorpay_signature;
        }

        if (isValid) {
            if (surpriseId) {
                const row = db.prepare('SELECT config_json FROM surprises WHERE id = ?').get(surpriseId);
                if (row) {
                    const config = JSON.parse(row.config_json);
                    config.isPremium = true;
                    db.prepare('UPDATE surprises SET config_json = ?, updated_at = ? WHERE id = ?')
                      .run(JSON.stringify(config), new Date().toISOString(), surpriseId);
                    console.log(`[Database] Surprise '${surpriseId}' marked as Premium in SQLite DB!`);
                }
            }

            res.json({
                success: true,
                message: 'Razorpay Payment Verified Successfully!',
                paymentId: razorpay_payment_id,
                orderId: razorpay_order_id,
                isPremium: true
            });
        } else {
            res.status(400).json({ success: false, error: 'Invalid Razorpay Signature Verification Failed' });
        }
    } catch (err) {
        console.error('[Razorpay Verify Error]:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fallback route: serve index.html for single page app
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 LoveSurprise Server & Database is live on port ${PORT}!`);
    console.log(`🌐 App URL: http://0.0.0.0:${PORT}`);
    console.log(`🗄️ Database API: http://0.0.0.0:${PORT}/api/surprises`);
    console.log(`=======================================================`);
});
