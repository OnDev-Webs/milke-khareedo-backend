/**
 * Script to fix user passwords (for users created with double hashing issue)
 * Run: node scripts/fix-user-passwords.js
 * 
 * This script fixes passwords for existing users by resetting them properly
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/database');
const User = require('../models/user');

// Users to fix (update with actual emails from your database)
const usersToFix = [
    {
        email: 'superadmin1@milke-khareedo.com',
        password: 'SuperAdmin@123'
    },
    {
        email: 'superadmin2@milke-khareedo.com',
        password: 'SuperAdmin@456'
    },
    {
        email: 'admin@milke-khareedo.com',
        password: 'Admin@789'
    }
];

async function fixUserPasswords() {
    try {
        // Connect to database
        console.log('🔄 Connecting to database...');
        await connectDB();
        console.log('✅ Database connected successfully\n');

        const fixedUsers = [];
        const errors = [];

        for (const userData of usersToFix) {
            try {
                console.log(`\n📝 Processing: ${userData.email}`);

                // Find user
                const user = await User.findOne({ 
                    email: userData.email.toLowerCase().trim()
                });

                if (!user) {
                    console.log(`⚠️  User not found: ${userData.email}`);
                    errors.push({
                        email: userData.email,
                        error: 'User not found'
                    });
                    continue;
                }

                // Reset password - hash it manually and update directly
                // This bypasses the pre-save hook to avoid double hashing
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(userData.password, salt);
                
                // Update password directly using updateOne to bypass pre-save hook
                await User.updateOne(
                    { _id: user._id },
                    { $set: { password: hashedPassword } }
                );

                console.log(`   ✅ Password fixed for: ${userData.email}`);
                console.log(`   📧 Email: ${userData.email}`);
                console.log(`   🔑 New Password: ${userData.password}`);

                fixedUsers.push({
                    id: user._id.toString(),
                    email: userData.email,
                    password: userData.password
                });

            } catch (error) {
                console.error(`   ❌ Error fixing user ${userData.email}:`, error.message);
                errors.push({
                    email: userData.email,
                    error: error.message
                });
            }
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 SUMMARY');
        console.log('='.repeat(60));
        console.log(`✅ Successfully fixed: ${fixedUsers.length} user(s)`);
        console.log(`❌ Errors: ${errors.length} user(s)\n`);

        if (fixedUsers.length > 0) {
            console.log('✅ FIXED USERS:');
            console.log('-'.repeat(60));
            fixedUsers.forEach((user, index) => {
                console.log(`\n${index + 1}. ${user.email}`);
                console.log(`   Password: ${user.password}`);
            });
        }

        if (errors.length > 0) {
            console.log('\n❌ ERRORS:');
            console.log('-'.repeat(60));
            errors.forEach((err, index) => {
                console.log(`${index + 1}. ${err.email}: ${err.error}`);
            });
        }

        console.log('\n' + '='.repeat(60));
        console.log('✨ Script completed!');
        console.log('='.repeat(60));
        console.log('\n💡 You can now login with the credentials above.');

        // Close database connection
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await mongoose.connection.close();
        process.exit(1);
    }
}

// Run the script
fixUserPasswords();
