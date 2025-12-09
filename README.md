# Milke Khareedo Backend

A complete Node.js + Express.js REST API backend project with MongoDB, JWT authentication, and proper project structure.

## 🚀 Tech Stack

- **Node.js** - JavaScript runtime
- **Express.js** - Web framework
- **MongoDB** - Database (using Mongoose)
- **JWT** - Authentication
- **bcryptjs** - Password hashing
- **express-validator** - Input validation
- **helmet** - Security headers
- **cors** - Cross-origin resource sharing
- **morgan** - HTTP request logger
- **dotenv** - Environment variables

## 📁 Project Structure

```
milke-khareedo-backend/
├── config/
│   ├── database.js          # MongoDB connection
│   └── jwt.js                # JWT configuration
├── controllers/
│   ├── userController.js     # User business logic
│   └── productController.js  # Product business logic
├── middleware/
│   ├── auth.js               # JWT authentication middleware
│   ├── errorHandler.js       # Global error handler
│   └── validator.js          # Request validation middleware
├── models/
│   ├── User.js               # User model
│   └── Product.js            # Product model
├── routes/
│   ├── api.js                # Main API router
│   ├── userRoutes.js         # User routes
│   └── productRoutes.js      # Product routes
├── utils/
│   └── response.js           # Response utility functions
├── .gitignore                # Git ignore file
├── env.example               # Environment variables example
├── package.json              # Dependencies and scripts
├── server.js                 # Main server file
└── README.md                 # Project documentation
```

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v14 or higher) - [Download Node.js](https://nodejs.org/)
- **MongoDB** - [Download MongoDB](https://www.mongodb.com/try/download/community) or use [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (cloud)
- **npm** or **yarn** - Comes with Node.js

## 🔧 Installation & Setup

### Step 1: Clone the repository

```bash
git clone <your-repo-url>
cd milke-khareedo-backend
```

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Environment Configuration

1. Copy the example environment file:

   ```bash
   copy env.example .env
   ```

   (On Linux/Mac: `cp env.example .env`)

2. Open `.env` file and update the following variables:

   ```env
   PORT=3000
   NODE_ENV=development
   MONGODB_URI=mongodb://localhost:27017/milke-khareedo
   JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
   JWT_EXPIRE=7d
   ```

   **Important:**

   - Change `JWT_SECRET` to a strong, random string in production
   - Update `MONGODB_URI` with your MongoDB connection string
   - For MongoDB Atlas, use: `mongodb+srv://username:password@cluster.mongodb.net/dbname`

### Step 4: Start MongoDB

**Local MongoDB:**

- Make sure MongoDB is running on your system
- Default connection: `mongodb://localhost:27017`

**MongoDB Atlas (Cloud):**

- Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
- Get your connection string and update `MONGODB_URI` in `.env`

### Step 5: Run the server

**Development mode (with auto-reload):**

```bash
npm run dev
```

**Production mode:**

```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in `.env`)

## 📡 API Endpoints

### Base URL

```
http://localhost:3000/api
```

### Health Check

```
GET /
Response: Server status and version
```

### User Endpoints

| Method | Endpoint              | Description              | Auth Required |
| ------ | --------------------- | ------------------------ | ------------- |
| POST   | `/api/users/register` | Register a new user      | No            |
| POST   | `/api/users/login`    | Login user               | No            |
| GET    | `/api/users/profile`  | Get current user profile | Yes           |
| GET    | `/api/users`          | Get all users            | Yes           |
| GET    | `/api/users/:id`      | Get user by ID           | Yes           |
| PUT    | `/api/users/:id`      | Update user              | Yes           |
| DELETE | `/api/users/:id`      | Delete user              | Yes           |

### Product Endpoints

| Method | Endpoint            | Description        | Auth Required |
| ------ | ------------------- | ------------------ | ------------- |
| GET    | `/api/products`     | Get all products   | No            |
| GET    | `/api/products/:id` | Get product by ID  | No            |
| POST   | `/api/products`     | Create new product | Yes           |
| PUT    | `/api/products/:id` | Update product     | Yes           |
| DELETE | `/api/products/:id` | Delete product     | Yes           |

## 🔐 Authentication

### Register User

```bash
POST /api/users/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123"
}
```

### Login

```bash
POST /api/users/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "password123"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": "...",
      "name": "John Doe",
      "email": "john@example.com"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### Using JWT Token

For protected routes, include the token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

Example:

```bash
GET /api/users/profile
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 📝 Example API Requests

### Create a Product

```bash
POST /api/products
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Sample Product",
  "description": "This is a sample product",
  "price": 99.99,
  "category": "Electronics",
  "stock": 100
}
```

### Get All Products

```bash
GET /api/products
```

### Update Product

```bash
PUT /api/products/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Updated Product Name",
  "price": 149.99
}
```

## 🛠️ Development

### Available Scripts

- `npm start` - Start the server in production mode
- `npm run dev` - Start the server in development mode with nodemon (auto-reload)

### Adding New Routes

1. Create a new route file in `routes/` directory
2. Create corresponding controller in `controllers/` directory
3. Create model in `models/` directory (if needed)
4. Import and use the route in `routes/api.js`

Example:

```javascript
// routes/newRoutes.js
const express = require("express");
const router = express.Router();
const newController = require("../controllers/newController");

router.get("/", newController.getAll);
router.post("/", newController.create);

module.exports = router;

// routes/api.js
const newRoutes = require("./newRoutes");
router.use("/new", newRoutes);
```

## 🔒 Security Features

- **Helmet** - Sets various HTTP headers for security
- **CORS** - Configures cross-origin resource sharing
- **JWT Authentication** - Secure token-based authentication
- **Password Hashing** - Uses bcryptjs for password encryption
- **Input Validation** - Uses express-validator for request validation
- **Error Handling** - Centralized error handling middleware

## 📦 Dependencies

### Production Dependencies

- `express` - Web framework
- `mongoose` - MongoDB ODM
- `jsonwebtoken` - JWT implementation
- `bcryptjs` - Password hashing
- `express-validator` - Input validation
- `dotenv` - Environment variables
- `cors` - CORS middleware
- `morgan` - HTTP logger
- `helmet` - Security headers

### Development Dependencies

- `nodemon` - Auto-reload in development

## 🐛 Error Handling

The API uses a centralized error handling middleware. All errors are returned in a consistent format:

```json
{
  "success": false,
  "message": "Error message here"
}
```

## 📄 Response Format

### Success Response

```json
{
  "success": true,
  "message": "Operation successful",
  "data": { ... }
}
```

### Error Response

```json
{
  "success": false,
  "message": "Error message"
}
```

## 🚀 Next Steps

1. **Add more models** - Create additional models as per your requirements
2. **Add more routes** - Extend the API with more endpoints
3. **Add file upload** - Implement image/file upload functionality
4. **Add pagination** - Implement pagination for list endpoints
5. **Add filtering & sorting** - Add query parameters for filtering and sorting
6. **Add unit tests** - Write tests using Jest or Mocha
7. **Add API documentation** - Use Swagger/OpenAPI for API documentation
8. **Deploy** - Deploy to platforms like Heroku, AWS, or DigitalOcean

## 📞 Support

For issues and questions, please open an issue in the repository.

## 📜 License

ISC

---

**Happy Coding! 🎉**
