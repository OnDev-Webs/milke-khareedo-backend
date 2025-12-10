const mongoose = require('mongoose');

const userSearchHistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    searchQuery: { type: String, required: true },
    location: { type: String },
    budgetMin: { type: Number },
    budgetMax: { type: Number },
}, { timestamps: true });

module.exports = mongoose.model('UserSearchHistory', userSearchHistorySchema);
