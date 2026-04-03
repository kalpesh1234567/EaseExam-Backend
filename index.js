require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
const swaggerDocs = require('./utils/swagger');
const swaggerUi = require('swagger-ui-express');
const logger = require('./utils/logger');

const app = express();

// Connect DB and Start Server
const startServer = async () => {
  try {
    await connectDB();
    
    // Middleware
    app.use(morgan('dev'));
    
    // Robust CORS: Allow local dev and production Vercel frontend
    const allowedOrigins = [
      'http://localhost:5173',
      'https://ease-exam-frontend.vercel.app',
      process.env.FRONTEND_URL
    ].filter(Boolean);

    const corsOptions = {
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      optionsSuccessStatus: 200
    };
    app.use(cors(corsOptions));
    app.use(express.json());
    app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // Serve static files

    // Swagger
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

    // Routes
    app.use('/api/auth',        require('./routes/auth'));
    app.use('/api/classrooms',  require('./routes/classrooms'));
    app.use('/api/exams',       require('./routes/exams'));
    app.use('/api/answer-keys', require('./routes/answerKey'));
    app.use('/api/submissions', require('./routes/submissions'));
    app.use('/api/results',     require('./routes/results'));
    app.use('/api/analytics',   require('./routes/analytics'));
    app.use('/api/export',      require('./routes/export'));
    app.use('/api/teacher',     require('./routes/teacher.routes'));
    app.use('/api/student',     require('./routes/student.routes'));
    app.use('/api/tests',       require('./routes/tests'));
    app.use('/api/questions',   require('./routes/questions'));

    // Keep original evaluate route as public utility
    app.use('/api/evaluate',    require('./routes/evaluate'));

    app.get('/api/health', (req, res) => res.json({ status: 'ok', msg: 'ASAE Production API running' }));

    app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📚 Swagger docs at http://localhost:${PORT}/api/docs`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
};

startServer();


