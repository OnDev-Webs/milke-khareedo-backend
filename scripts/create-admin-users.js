/**
 * Script to create Admin Users
 * Run: node scripts/create-admin-users.js
 * 
 * This script creates:
 * - 2 Super Admin users
 * - 1 Admin user
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/database');
const User = require('../models/user');
const Role = require('../models/role');

// User data to create
const usersToCreate = [
    {
        name: 'Super Admin 1',
        firstName: 'Super',
        lastName: 'Admin 1',
        email: 'superadmin1@milke-khareedo.com',
        phoneNumber: '9876543210',
        password: 'SuperAdmin@123',
        roleName: 'Super Admin'
    },
    {
        name: 'Super Admin 2',
        firstName: 'Super',
        lastName: 'Admin 2',
        email: 'superadmin2@milke-khareedo.com',
        phoneNumber: '9876543211',
        password: 'SuperAdmin@456',
        roleName: 'Super Admin'
    }
];

// Super Admin permissions
const superAdminPermissions = {
    property: {
        add: true,
        edit: true,
        view: true,
        delete: true
    },
    developer: {
        add: true,
        edit: true,
        view: true,
        delete: true
    },
    crm: {
        add: true,
        edit: true,
        view: true,
        delete: true,
        export: true
    },
    team: {
        add: true,
        edit: true,
        view: true,
        delete: true
    },
    blogs: {
        add: true,
        edit: true,
        view: true,
        delete: true
    }
};

// Admin permissions (similar to Super Admin but can be customized)
const adminPermissions = {
    property: {
        add: true,
        edit: true,
        view: true,
        delete: true
    },
    developer: {
        add: true,
        edit: true,
        view: true,
        delete: true
    },
    crm: {
        add: true,
        edit: true,
        view: true,
        delete: true,
        export: true
    },
    team: {
        add: true,
        edit: true,
        view: true,
        delete: true
    },
    blogs: {
        add: true,
        edit: true,
        view: true,
        delete: true
    }
};

async function createUsers() {
    try {
        // Connect to database
        console.log('🔄 Connecting to database...');
        await connectDB();
        console.log('✅ Database connected successfully\n');

        const createdUsers = [];
        const errors = [];

        for (const userData of usersToCreate) {
            try {
                console.log(`\n📝 Processing: ${userData.name} (${userData.email})`);

                // Check if user already exists
                const existingUser = await User.findOne({
                    $or: [
                        { email: userData.email },
                        { phoneNumber: userData.phoneNumber }
                    ]
                }).lean();

                if (existingUser) {
                    console.log(`⚠️  User already exists with email: ${userData.email}`);
                    errors.push({
                        email: userData.email,
                        error: 'User already exists'
                    });
                    continue;
                }

                // Find or create role
                let role = await Role.findOne({ name: userData.roleName }).lean();

                if (!role) {
                    console.log(`   Creating role: ${userData.roleName}`);
                    const permissions = userData.roleName === 'Super Admin'
                        ? superAdminPermissions
                        : adminPermissions;

                    role = await Role.create({
                        name: userData.roleName,
                        permissions: permissions
                    });
                    console.log(`   ✅ Role created: ${role.name}`);
                } else {
                    console.log(`   ✅ Role found: ${role.name}`);
                }

                // Create user - password will be automatically hashed by User model's pre('save') hook
                // Don't hash manually, let the model handle it
                const user = await User.create({
                    name: userData.name,
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                    email: userData.email.toLowerCase().trim(),
                    phoneNumber: userData.phoneNumber,
                    countryCode: '+91',
                    password: userData.password, // Model hook will hash this automatically
                    role: role._id,
                    isActive: true,
                    isPhoneVerified: true
                });

                console.log(`   ✅ User created successfully!`);
                console.log(`   📧 Email: ${userData.email}`);
                console.log(`   🔑 Password: ${userData.password}`);
                console.log(`   👤 Name: ${userData.name}`);
                console.log(`   📱 Phone: ${userData.phoneNumber}`);
                console.log(`   🎭 Role: ${userData.roleName}`);

                createdUsers.push({
                    id: user._id.toString(),
                    name: userData.name,
                    email: userData.email,
                    phoneNumber: userData.phoneNumber,
                    password: userData.password,
                    role: userData.roleName
                });

            } catch (error) {
                console.error(`   ❌ Error creating user ${userData.email}:`, error.message);
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
        console.log(`✅ Successfully created: ${createdUsers.length} user(s)`);
        console.log(`❌ Errors: ${errors.length} user(s)\n`);

        if (createdUsers.length > 0) {
            console.log('✅ CREATED USERS:');
            console.log('-'.repeat(60));
            createdUsers.forEach((user, index) => {
                console.log(`\n${index + 1}. ${user.name} (${user.role})`);
                console.log(`   Email: ${user.email}`);
                console.log(`   Password: ${user.password}`);
                console.log(`   Phone: ${user.phoneNumber}`);
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
createUsers();
