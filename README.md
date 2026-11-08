# نشر الاستديو (Cloudflare Worker + D1)

## الهيكل
- `public/index.html`  ← التطبيق (الملف المعدّل كامل)
- `public/sw.js`       ← Service Worker بدون كاش (يمنع ظهور نسخ قديمة)
- `worker.js`          ← الـ Backend (الصور، المحتوى، الفواتير، الزيارات، تأكيد الدفع)
- `schema.sql`, `wrangler.toml`
- `test/`              ← اختبارات التشغيل المحلي (اختيارية)

## خطوات النشر (الأسهل)
1. ارفع **محتويات مجلد `studio` كلها** على GitHub بنفس الشكل (`worker.js` و`wrangler.toml` و`package.json` و`public/index.html` و`public/sw.js`). مهم: `index.html` لازم يبقى جوه مجلد `public`.
2. اسم الـ Worker جاهز في `wrangler.toml`: `mo-art-studio-app`، فلازم يكون هو نفس الاسم في Cloudflare (Workers & Pages). رابط الموقع هيبقى `https://mo-art-studio-app.<حسابك>.workers.dev`، وده الرابط اللي تضيفه في Google (Authorized JavaScript origins).
3. خلّي Cloudflare يعمل Deploy (أمر النشر: `npx wrangler deploy`). قاعدة البيانات والجداول بتتعمل تلقائيًا؛ ولو ظهر خطأ في `database_id` اتبع الملاحظة جوه `wrangler.toml`.
4. كلمة سر الإدارة: `Marim*` (شغّالة تلقائيًا، وتقدر تغيّرها من الإدارة → تغيير كلمة السر).

## لو ظهرت رسالة خطأ
- «الخادم (Backend) مش شغال أو مش منشور — كود: http404» ← الـ Worker مش منشور أو `index.html` مش جوه `public`.
- كود `no_db` ← قاعدة البيانات (D1) مش مربوطة باسم `DB`.
- «كلمة السر غلط» ← ظهرت بس لو الخادم رد فعلًا إن الباسورد غلط.
- Google: `origin_mismatch` ← ضيف رابط الموقع في Authorized JavaScript origins (الرابط مكتوب لك جوه الإدارة → الإعدادات).

## شات الذكاء الاصطناعي (أدوات مجانية بالتتابع)
بيجرّب بالترتيب لحد ما واحدة ترد: Cloudflare Workers AI ← Groq ← Google Gemini ← OpenRouter (مجاني) ← Pollinations (بدون مفتاح).
المفاتيح اختيارية: `npx wrangler secret put GROQ_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`. بدونها بيشتغل Pollinations.

## تسجيل Google
لازم رابط الموقع (`https://...workers.dev` أو دومينك) يكون مضاف في Google Cloud Console → Credentials → OAuth Client → **Authorized JavaScript origins**. ده أشهر سبب إن التسجيل مبيشتغلش.

## الموسيقى
إلكترونيك هادي حديث مولّد داخل التطبيق (مفيش ملف صوت)، بتبدأ بعد أول لمسة، وزر 🔊 لإيقافها. تقدر تحط رابط mp3 من الإدارة → الإعدادات.

## الفواتير والصور
- كارت «فواتيري»: بحث برقم الفاتورة أو رقم الواتس (حالة فقط بدون بيانات شخصية)، والفاتورة الكاملة لما تكتب الاتنين.
- إرسال صورة التحويل من صفحة عادية داخل التطبيق، بتتحفظ على الخادم وتظهر للإدارة في قائمة الفواتير (زر «الصور»).
- الأوردر مش مشروط بتسجيل جوجل؛ جوجل في التسجيل الأول فقط.
