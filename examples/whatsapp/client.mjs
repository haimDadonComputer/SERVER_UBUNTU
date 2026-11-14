// Integrate in your own project; install whatsapp-web.js and use a persistent shared directory.
// No --no-sandbox flag. Chromium sandbox compatibility must be checked on the actual host.
import whatsapp from 'whatsapp-web.js';
import fs from 'node:fs';
const {Client,LocalAuth}=whatsapp;
const root=process.env.WWEBJS_DATA_PATH;
if(!root)throw new Error('WWEBJS_DATA_PATH is required');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const client=new Client({authStrategy:new LocalAuth({dataPath:root}),puppeteer:{headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH}});
// Feed QR to a private, authenticated application endpoint; never log QR or session data.
client.on('qr',qr=>{fs.writeFileSync(root+'/qr.json',JSON.stringify({qr,expires:Date.now()+45000}),{mode:0o600});});
client.on('ready',()=>{fs.rmSync(root+'/qr.json',{force:true});console.log('WhatsApp client ready');});
client.on('auth_failure',()=>console.error('WhatsApp authentication failed'));
client.initialize();
