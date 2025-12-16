const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const betterstackToken = 'tLyg1BbYWedMQHJi635HjPgrHjksXUH8';

// Read existing .env file if it exists
let envContent = '';
if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
}

// Check if BETTERSTACK_SOURCE_TOKEN already exists
if (envContent.includes('BETTERSTACK_SOURCE_TOKEN')) {
    // Update existing token
    envContent = envContent.replace(
        /BETTERSTACK_SOURCE_TOKEN=.*/g,
        `BETTERSTACK_SOURCE_TOKEN=${betterstackToken}`
    );
    console.log('Updated BETTERSTACK_SOURCE_TOKEN in .env file');
} else {
    // Add token to .env file
    if (envContent && !envContent.endsWith('\n')) {
        envContent += '\n';
    }
    envContent += `\n# BetterStack Logging\nBETTERSTACK_SOURCE_TOKEN=${betterstackToken}\nLOG_LEVEL=info\n`;
    console.log('Added BETTERSTACK_SOURCE_TOKEN to .env file');
}

// Write back to .env file
fs.writeFileSync(envPath, envContent, 'utf8');
console.log('Environment file updated successfully!');
