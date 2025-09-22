const { createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

async function generateLeaderboardImage(title, users, type) {
    const width = 800;
    const height = 600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Load a background image if you want, otherwise use a solid color
    try {
        const backgroundImage = await loadImage(path.join(__dirname, 'background.png'));
        ctx.drawImage(backgroundImage, 0, 0, width, height);
    } catch (err) {
        console.error('Could not load background image, using a fallback color.');
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, width, height);
    }
    
    // Set text style and shadow
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 5;

    // Title
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, 70);

    // List of users
    ctx.font = '28px sans-serif';
    ctx.textAlign = 'left';
    let y = 150;
    
    for (const [index, user] of users.entries()) {
        // Draw the user's avatar
        if (user.avatarUrl) {
            try {
                const avatar = await loadImage(user.avatarUrl);
                ctx.save();
                ctx.beginPath();
                ctx.arc(60, y - 10, 25, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(avatar, 35, y - 35, 50, 50);
                ctx.restore();
            } catch (err) {
                console.error(`Failed to load avatar for ${user.name}:`, err);
            }
        }
        
        const text = `#${index + 1} ${user.name}: ${user.value} ${type}`;
        ctx.fillText(text, 100, y);
        y += 60;
    }

    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(__dirname, 'leaderboard.png'), buffer);
}

module.exports = { generateLeaderboardImage };
