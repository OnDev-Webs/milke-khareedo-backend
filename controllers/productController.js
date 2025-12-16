const Product = require('../models/product');
const { logInfo, logError } = require('../utils/logger');

// @desc    Get all products
// @route   GET /api/products
// @access  Public
exports.getAllProducts = async (req, res, next) => {
    try {
        // Optimize query with lean() for better performance
        const products = await Product.find().lean();
        logInfo('Get all products', { count: products.length });
        res.json({
            success: true,
            count: products.length,
            data: products
        });
    } catch (error) {
        logError('Error getting all products', error);
        next(error);
    }
};

// @desc    Get product by ID
// @route   GET /api/products/:id
// @access  Public
exports.getProductById = async (req, res, next) => {
    try {
        // Optimize query with lean() for better performance
        const product = await Product.findById(req.params.id).lean();
        if (!product) {
            logInfo('Product not found', { productId: req.params.id });
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        logInfo('Get product by ID', { productId: req.params.id });
        res.json({
            success: true,
            data: product
        });
    } catch (error) {
        logError('Error getting product by ID', error, { productId: req.params.id });
        next(error);
    }
};

// @desc    Create new product
// @route   POST /api/products
// @access  Private
exports.createProduct = async (req, res, next) => {
    try {
        const product = await Product.create(req.body);
        logInfo('Product created', { productId: product._id });
        res.status(201).json({
            success: true,
            message: 'Product created successfully',
            data: product
        });
    } catch (error) {
        logError('Error creating product', error);
        next(error);
    }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private
exports.updateProduct = async (req, res, next) => {
    try {
        const product = await Product.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true, lean: true }
        );

        if (!product) {
            logInfo('Product not found for update', { productId: req.params.id });
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        logInfo('Product updated', { productId: req.params.id });
        res.json({
            success: true,
            message: 'Product updated successfully',
            data: product
        });
    } catch (error) {
        logError('Error updating product', error, { productId: req.params.id });
        next(error);
    }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private
exports.deleteProduct = async (req, res, next) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) {
            logInfo('Product not found for deletion', { productId: req.params.id });
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        logInfo('Product deleted', { productId: req.params.id });
        res.json({
            success: true,
            message: 'Product deleted successfully'
        });
    } catch (error) {
        logError('Error deleting product', error, { productId: req.params.id });
        next(error);
    }
};

