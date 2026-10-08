# runclub
runclub registration and verification
# Run Club Registration & QR Check-in

ระบบลงทะเบียนกิจกรรมวิ่งรายสัปดาห์ + เช็กอินด้วย QR

```
ผู้ร่วมงาน ──► docs/index.html  (ฟอร์มลงทะเบียน)
                    │  POST
                    ▼
        Google Apps Script (backend/Code.gs)  ──►  Google Sheet (ฐานข้อมูล)
                    │                                 Event · Registrations · Codes · ScanLog
                    └─► อีเมลยืนยัน (ปุ่ม → docs/qr.html?t=<token>)

วันงาน:  ผู้ร่วมงานเปิด docs/qr.html  → ได้ QR สดใหม่ (ddMMyyyyHHmmss + 5 ตัวอักษร)
         เจ้าหน้าที่เปิด docs/staff.html → สแกนด้วยกล้อง → ✅ เขียว / ❌ แดง
```

## กติกา QR (ตรวจที่เซิร์ฟเวอร์ทั้งหมด)

| เงื่อนไข | ผลลัพธ์ |
|---|---|
| รหัสไม่มีในระบบ (ปลอมรูปแบบเอง) | ❌ QR not recognised |
| วันที่ในรหัสไม่ใช่วันนี้ หรือวันนี้ไม่ใช่วันงาน (ตามเขตเวลาของงาน) | ❌ Wrong date |
| รหัสนี้เคยถูกใช้แล้ว | ❌ QR already used |
| เวลาที่ออก QR ต่างจากเวลาเซิร์ฟเวอร์ ณ ตอนสแกน เกิน ±5 นาที (เวลาเครื่องมือถือไม่เกี่ยว) | ❌ QR expired |
| คนนี้เช็กอินไปแล้ว (ด้วยรหัสอื่น) | ❌ Already checked in |
| ผ่านทุกข้อ | ✅ Check-in successful + ชื่อ |

**หน้า QR ของผู้ร่วมงาน** แสดง QR พร้อม timer เสมอ ถ้ายังไม่ถึงวันงานจะมีข้อความ "ใช้ได้ในวันงานเท่านั้น" และถ้าเลยวันงานแล้วจะมีข้อความ "กิจกรรมจบแล้ว" (สแกนจริงจะไม่ผ่านอยู่ดีเพราะตรวจวันที่ที่เซิร์ฟเวอร์)

**การบันทึกในชีต**
- `Codes`: `used_at` + `result` บันทึกผลของ **การสแกนครั้งแรก** ของ QR แต่ละใบ (`ok` หรือเหตุผล เช่น `expired`, `wrong_day`, `already_checked_in`) การสแกนซ้ำไม่เขียนทับ ถ้าครั้งแรกไม่ผ่านแต่ภายหลังผ่าน จะบันทึกเป็น `ok`
- `ScanLog`: ทุกครั้งที่สแกน (ผ่านหรือไม่ผ่าน รวมรหัสที่ไม่มีในระบบ)
- `Registrations.checked_in_at`: คนที่เข้างานจริง

## ติดตั้งของจริง (ประมาณ 20 นาที)

### 1) Google Sheet + Apps Script
1. สร้าง Google Sheet ใหม่ (ตั้งชื่ออะไรก็ได้)
2. เมนู **Extensions → Apps Script** แล้ววางโค้ดจาก [`backend/Code.gs`](backend/Code.gs) ทับของเดิมทั้งหมด
3. เลือกฟังก์ชัน **`setup`** แล้วกด **Run** (ครั้งแรกจะขอสิทธิ์ Sheet + ส่งอีเมล ให้กดอนุญาต)
4. กลับไปที่ชีต จะมีแท็บ `Event`, `Registrations`, `Codes`, `ScanLog` ให้ ในแท็บ `Event` แก้ค่าต่างๆ (ดูตาราง config ด้านล่าง) **จด `staff_pin` ไว้**
5. **Deploy → New deployment → Web app** · Execute as: **Me** · Who has access: **Anyone** → Deploy → คัดลอก URL ที่ลงท้ายด้วย `/exec`

> ทุกครั้งที่แก้ `Code.gs` ต้อง **Deploy → Manage deployments → Edit → New version** ถึงจะมีผล (URL เดิม)

**อัปเกรดจากเวอร์ชันก่อนหน้า (ที่ใช้แถว `datetime`):** วางโค้ด `Code.gs` ใหม่ → เลือก `setup` แล้ว Run (จะแปลงแถว `datetime` เป็นแถว `date` + `time` ให้อัตโนมัติ และเพิ่มแถว `timezone`) → ตรวจค่าในแท็บ `Event` → Deploy → New version

### 2) หน้าเว็บบน GitHub Pages
1. เปิด `docs/config.js` แล้วใส่ URL จากข้อ 1.5 ใน `API_URL`
2. Push โฟลเดอร์นี้ขึ้น GitHub → Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, Folder: **`/docs`**
3. นำ URL ของเว็บ (เช่น `https://<user>.github.io/<repo>`) ไปใส่ที่ `site_url` ในแท็บ `Event` (ใช้สร้างปุ่มในอีเมล, **ไม่ต้องมี `/` ท้าย**)

### 3) ทดลองก่อนวันจริง
- ตั้ง `date` ในแท็บ `Event` เป็นวันนี้ (dd-mm-yyyy) แล้วลองลงทะเบียน → รับอีเมล → เปิดปุ่ม → ให้เจ้าหน้าที่สแกนจากมือถืออีกเครื่อง
- ลบแถวทดสอบในแท็บ `Registrations`, `Codes`, `ScanLog` ก่อนเปิดจริง (เก็บแถวหัวตารางไว้)

## ค่า Config ในแท็บ `Event` (แก้ในชีตได้เลย มีผลทันที)

| key | ความหมาย |
|---|---|
| `event_name`, `place`, `route`, `notes` | ข้อมูลที่แสดงในฟอร์มและอีเมล (ไทย/อังกฤษได้, ขึ้นบรรทัดใหม่ได้) |
| `date` | วันงานแบบ `dd-mm-yyyy` เช่น `11-10-2026` (รับ `/` ด้วย) — **QR เช็กอินใช้ได้เฉพาะวันนี้เท่านั้น** ถ้าว่างหรือผิดรูปแบบ ฟอร์มจะปิดรับสมัครและหน้าเจ้าหน้าที่จะแจ้งเตือน |
| `time` | เวลาเริ่มงาน `hh:mm` 24 ชั่วโมง เช่น `06:00` (ใช้แสดงผลเท่านั้น) |
| `timezone` | (ไม่บังคับ) เขตเวลาของสถานที่จัดงาน เช่น `America/New_York`, `Europe/London` ว่าง = `Asia/Bangkok` ใช้กำหนดว่า "วันนี้คือวันไหน" และรองรับเวลาออมแสง ถ้างานช่วงเช้าและเว้นว่างไว้จะยังใช้ได้ แต่งานช่วงบ่าย/ค่ำที่ต่างประเทศควรตั้งค่า |
| `capacity` | จำนวนที่นั่ง (0 = ไม่จำกัด) |
| `banner_url`, `logo_url` | ลิงก์รูป https หรือลิงก์แชร์ Google Drive (PNG พื้นโปร่ง/SVG สำหรับโลโก้, banner กว้าง ≥1200px) |
| `primary_color`, `bg_color`, `text_color` | สี HEX ตาม CI |
| `font_family`, `font_url` | ชื่อฟอนต์ + ลิงก์ Google Fonts (ถ้าใช้) เช่น `Prompt` และ `https://fonts.googleapis.com/css2?family=Prompt:wght@400;600&display=swap` |
| `site_url` | ที่อยู่เว็บ (ใช้ในปุ่มอีเมล) |
| `staff_pin` | PIN สำหรับเจ้าหน้าที่ **(ไม่เคยถูกส่งออกไปหน้าเว็บสาธารณะ)** |
| `email_sender_name` | ชื่อผู้ส่งอีเมล (ว่างไว้ = ใช้ชื่อบัญชี Google) |

อีเมลถูกส่งจากบัญชี Google ที่ deploy script (Gmail ฟรีส่งได้ราว 100 ฉบับ/วัน)

## ลองในเครื่อง (ไม่ต้องมี Google)

```bash
node tests/backend.test.js    # ทดสอบกติกาทั้งหมดของ backend (ไม่ต้องติดตั้งอะไร)
node tests/dev-server.js      # http://localhost:8787  — รัน Code.gs จริงกับชีตจำลองในหน่วยความจำ
```

dev server: staff PIN คือ `DEVPIN88`, อีเมลไม่ได้ส่งจริงแต่ดูได้ที่ `/_dev/mails`, ดูข้อมูลชีตที่ `/_dev/info`,
เลื่อนนาฬิกาทดสอบหมดอายุด้วย `POST /_dev/clock {"offsetMin": 6}`

## โครงสร้างไฟล์

```
backend/Code.gs        กติกา, ส่งอีเมล, อ่าน/เขียนชีต (วางใน Apps Script)
docs/                  เว็บ static สำหรับ GitHub Pages
  index.html           ฟอร์มลงทะเบียน
  qr.html              หน้า QR ของผู้ร่วมงาน
  staff.html           หน้าสแกนของเจ้าหน้าที่
  config.js            ใส่ URL ของ Apps Script ที่นี่
  vendor/              jsQR, qrcode-generator (เก็บในโปรเจกต์ ไม่พึ่ง CDN)
tests/                 ชุดทดสอบ + dev server
mockup/, qr-app/       ภาพจำลอง flow และต้นแบบแรก (ไม่ได้ใช้ในระบบจริง)
```

## ข้อควรรู้ด้านความปลอดภัย / ข้อจำกัด

- QR ที่ส่งภาพให้เพื่อนได้ แต่ใช้ได้ครั้งเดียว/ภายใน 5 นาที และหน้าจอเจ้าหน้าที่แสดงชื่อ ให้เทียบกับตัวคนได้
- หน้าเจ้าหน้าที่ป้องกันด้วย PIN เดียว (8 ตัวอักษรสุ่ม) ถ้าหลุดให้เปลี่ยนค่า `staff_pin` ในชีตได้ทันที
- หน้างานต้องมีอินเทอร์เน็ตทั้งฝั่งผู้ร่วมงาน (เปิด QR) และเจ้าหน้าที่ (ตรวจรหัส)
- กล้องมือถือใช้ได้เฉพาะบน HTTPS (GitHub Pages เป็น HTTPS อยู่แล้ว)
- Apps Script ตอบช้าประมาณ 1–3 วินาทีต่อครั้ง ถือว่าปกติ
- ข้อมูลส่วนบุคคล (ชื่อ อีเมล social) อยู่ใน Google Sheet ของคุณ ควรแชร์ชีตเฉพาะผู้ที่จำเป็น และ repo ของเว็บไม่มีข้อมูลผู้ลงทะเบียน (มีแค่ URL ของ API)
