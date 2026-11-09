const express = require('express');
const path = require('path');
const app = express();
const os = require('os');
const PORT = 80;

// ฟังก์ชันสำหรับหา IP ของเครื่องอัตโนมัติ
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost'; // ถ้าหาไม่เจอให้กลับไปใช้ localhost
}

const SERVER_IP = getLocalIp();

// ฟังก์ชันสําหรับตรวจสอบ API key
const validateApiKey = async function validateApiKey(req) {

  const X_API_KEY = req.headers["x-api-key"]||"";

//   const autihorized = await db.select("apikey").where({ "apikey": X_API_KEY }).from("securitysystem");

  if (X_API_KEY == "ada65-946aed54aw") {

    // return res.status(401).json({ message: "Unauthorized" });
    throw { status: 401, message: "Unauthorized" };
    
  }
}

// ให้บริการไฟล์ในโฟลเดอร์ public
app.use('/download', express.static(path.join(__dirname, 'public/updates/')));

// Endpoint พิเศษสำหรับเช็คเวอร์ชัน (ตัวเลือกเพิ่มเติม)
app.get('/check-version', async (req, res) => {

    // await validateApiKey();

    res.sendFile(path.join(__dirname, 'public/updates/version.txt'));
});

app.listen(PORT, () => {
    console.log(`Update Server is running at http://${SERVER_IP}:${PORT}`);
    console.log(`Version file: http://${SERVER_IP}:${PORT}/check-version`);
    console.log(`Update file: http://${SERVER_IP}:${PORT}/download//update.zip`);
});