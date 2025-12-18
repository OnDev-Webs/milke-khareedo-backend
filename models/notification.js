const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    leadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead',
        required: true
    },
    propertyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Property'
    },
    notificationType: {
        type: String,
        enum: ['follow_up', 'phone_call', 'whatsapp', 'email', 'visit', 'status_update', 'remark_update', 'join_group'],
        required: true
    },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    source: {
        type: String, // Agent/User name who performed the action
        required: true
    },
    sourceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    isRead: {
        type: Boolean,
        default: false,
        index: true
    },
    // Additional data based on notification type
    metadata: {
        projectName: String,
        projectId: String,
        nextFollowUpDate: Date,
        leadContactName: String,
        activityDescription: String,
        oldStatus: String,
        newStatus: String
    }
}, {
    timestamps: true
});

// Index for faster queries
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ leadId: 1 });
notificationSchema.index({ propertyId: 1 });

module.exports = mongoose.model('Notification', notificationSchema);

