const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
    add: {
        type: Boolean,
        default: false
    },
    edit: {
        type: Boolean,
        default: false
    },
    view: {
        type: Boolean,
        default: false
    },
    delete: {
        type: Boolean,
        default: false
    },
    export: {
        type: Boolean,
        default: false
    }
}, { _id: false });

const roleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Role name is required'],
        unique: true,
        trim: true
    },
    permissions: {
        property: {
            type: permissionSchema,
            default: () => ({ add: false, edit: false, view: false, delete: false })
        },
        developer: {
            type: permissionSchema,
            default: () => ({ add: false, edit: false, view: false, delete: false })
        },
        crm: {
            type: permissionSchema,
            default: () => ({ add: false, edit: false, view: false, delete: false, export: false })
        },
        team: {
            type: permissionSchema,
            default: () => ({ add: false, edit: false, view: false, delete: false })
        },
        blog: {
            type: permissionSchema,
            default: () => ({ add: false, edit: false, view: false, delete: false })
        }
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Role', roleSchema);

