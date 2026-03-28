const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'EasyExam API',
      version: '1.0.0',
      description: 'Automated Answer Sheet Evaluation System — REST API Documentation',
      contact: { name: 'JSCOE IT Department' },
    },
    servers: [{ url: 'http://localhost:5000', description: 'Development server' }],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ BearerAuth: [] }],
  },
  apis: ['./routes/*.js'],
};

module.exports = swaggerJsdoc(options);
