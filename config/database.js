const mongoose = require('mongoose');
const { logInfo, logError } = require('../utils/logger');

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            maxPoolSize: 10, // Maintain up to 10 socket connections
            serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
            socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
            bufferMaxEntries: 0, // Disable mongoose buffering
            bufferCommands: false, // Disable mongoose buffering
        });

        logInfo('MongoDB Connected', {
            host: conn.connection.host,
            database: conn.connection.name
        });
        console.log(`MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        logError('MongoDB Connection Error', error);
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;

