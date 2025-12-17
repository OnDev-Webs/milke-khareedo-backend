const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    propertyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Property"
    },
    relationshipManagerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    rmEmail: { type: String },
    rmPhone: { type: String },
    message: { type: String },
    date: {
        type: Date,
        default: Date.now
    },
    scheduleDate: {
        type: Date
    },
    isStatus: {
        type: Boolean,
        default: true
    },
    source: {
        type: String,
        default: "origin"
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    visitStatus: {
        type: String,
        enum: ['not_visited', 'visited', 'follow_up'],
        default: 'not_visited'
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    }
}, {
    timestamps: true
});

module.exports = mongoose.model("Lead", leadSchema);
