# EasyExam Backend API
Production-grade Automated Answer Sheet Evaluation System Backend.

Built with **Node.js, Express, MongoDB, Google Gemini AI, and Tesseract.js (OCR)**.

## Features
- **JWT Authentication & RBAC**: Secure routes for `Teacher` and `Student` roles.
- **OCR Engine**: Extracts text from student answer sheets (Image/PDF) via `tesseract.js` + `pdf-parse`.
- **AI Evaluation**: Semantically compares student answers against teacher solution keys using **Gemini 1.5 Flash**.
- **Analytics**: Calculates class averages, fail counts, and top performers.
- **Exporting**: Generates CSV and PDF result reports for teachers.
- **Swagger API Docs**: Full documentation at `/api/docs`.

## Local Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables (.env)
Create a `.env` file in the root:
```env
PORT=5000
MONGODB_URI="mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/easyexam"
JWT_SECRET="your_jwt_secret"
GEMINI_API_KEY="your_google_ai_studio_key"
```

### 3. Run Development Server
```bash
npm run dev
```

The server will start on `http://localhost:5000`. 
API Documentation available at `http://localhost:5000/api/docs`.
