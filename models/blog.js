const mongoose = require('mongoose');

const blogSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Please provide a blog title'],
        trim: true
    },
    subtitle: {
        type: String,
        trim: true
    },
    category: {
        type: String,
        trim: true
    },
    author: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    authorName: {
        type: String,
        required: true
    },
    tags: [{
        type: String,
        trim: true
    }],
    bannerImage: {
        type: String,
        default: null
    },
    galleryImages: [{
        type: String
    }],
    content: {
        type: String,
        required: [true, 'Please provide blog content']
    },
    slug: {
        type: String,
        unique: true,
        trim: true
    },
    isPublished: {
        type: Boolean,
        default: false
    },
    views: {
        type: Number,
        default: 0
    },
    isStatus: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Generate slug from title before saving
blogSchema.pre('save', function (next) {
    if (this.isModified('title') || this.isNew) {
        // Create slug from title
        this.slug = this.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

        // Ensure uniqueness by appending timestamp if needed
        // This will be handled by unique index
    }
    next();
});

// Index for faster queries
blogSchema.index({ slug: 1 });
blogSchema.index({ isPublished: 1, isStatus: 1 });
blogSchema.index({ category: 1 });
blogSchema.index({ author: 1 });
blogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Blog', blogSchema);



