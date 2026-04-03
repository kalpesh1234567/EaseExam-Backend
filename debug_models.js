const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function testFinalFix() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log('Testing model: gemini-1.5-flash-latest...');
    
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest"
    });

    const result = await model.generateContent("Say hello");
    console.log('SUCCESS:', result.response.text());
  } catch (err) {
    console.error('FAILED:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

testFinalFix();
