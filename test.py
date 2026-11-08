import subprocess, time, os, sqlite3, json, sys, re
from playwright.sync_api import sync_playwright
PORT=8799; BASE=f'http://localhost:{PORT}'; DB='/tmp/studio-test.db'
RES=[]; ERR=[]
def ok(name,cond,extra=''):
    RES.append((name,bool(cond),extra)); print(('PASS ' if cond else 'FAIL ')+name+(' | '+str(extra) if extra and not cond else ''))
def q(sql,*a):
    c=sqlite3.connect(DB); r=c.execute(sql,a).fetchall(); c.close(); return r
def gal(cat,tr):
    st=json.loads(q("select v from kv where k='studio'")[0][0])['state']
    return [x for x in st['gal'] if x['cat']==cat and x.get('tr')==tr]
def poll(fn,timeout=60):
    end=time.time()+timeout
    while time.time()<end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(.3)
    return False
def start():
    env=dict(os.environ,PORT=str(PORT),DBFILE=DB)
    p=subprocess.Popen(['node','--no-warnings','server.mjs'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    for _ in range(50):
        time.sleep(.2)
        try:
            import urllib.request; urllib.request.urlopen(BASE+'/api/studio'); return p
        except Exception: pass
    raise SystemExit('server failed')
for f in (DB,DB+'-wal',DB+'-shm'):
    if os.path.exists(f): os.remove(f)
srv=start()

def new_ctx(br,**kw):
    ctx=br.new_context(viewport={'width':430,'height':900},locale='ar-EG',**kw)
    def route(r):
        u=r.request.url
        if u.startswith(BASE) or u.startswith('data:') or u.startswith('blob:'): return r.continue_()
        if 'wa.me' in u: return r.fulfill(status=200,content_type='text/html',body='<html><body>wa-stub</body></html>')
        ct='application/javascript' if u.endswith('.js') or 'gsi' in u else 'text/css' if 'css' in u else 'text/plain'
        r.fulfill(status=200,content_type=ct,body='')
    ctx.route('**/*',route); return ctx
def new_page(ctx,tag):
    pg=ctx.new_page()
    pg.on('pageerror',lambda e:ERR.append((tag,'pageerror',str(e))))
    pg.on('console',lambda m:ERR.append((tag,'console',m.text)) if m.type=='error' else None)
    pg.on('dialog',lambda d:(DLG.append(d.message),d.accept()))
    return pg
DLG=[]
def wf(pg,expr,timeout=20000):
    end=time.time()+timeout/1000
    while time.time()<end:
        if pg.evaluate(expr): return True
        time.sleep(.25)
    raise TimeoutError(expr)
def skip_auth(pg):
    pg.wait_for_selector('#ask',timeout=8000); pg.click('#ask')
def api(pg,path,method='GET',headers=None,body=None):
    return pg.evaluate("""async([p,m,h,b])=>{const r=await fetch(p,{method:m,headers:h||{},body:b?JSON.stringify(b):undefined});let j=null;try{j=await r.json()}catch(e){}return {s:r.status,j}}""",[path,method,headers,body])

with sync_playwright() as pw:
    br=pw.chromium.launch()
    # ---------- A. customer opens BEFORE any admin upload ----------
    cust=new_ctx(br,permissions=['geolocation'],geolocation={'latitude':30.04441,'longitude':31.23571})
    pc=new_page(cust,'cust'); pc.goto(BASE); skip_auth(pc); pc.wait_for_timeout(1500)
    names=pc.eval_on_selector_all('#sv > div','els=>els.map(e=>e.textContent.trim())')
    ok('4 specialties only, exact names/order',names==['رسم غرافيتي','نحت Relief','Effect','Tableau'],names)
    ok('admin password hash not in public HTML', '161ba00be2d5b8ba' not in pc.content())
    ok('public /api/studio empty before first publish', api(pc,'/api/studio')['j'].get('empty') is True)
    # ---------- B. admin login ----------
    adm=new_ctx(br); pa=new_page(adm,'admin'); pa.goto(BASE+'/#admin'); pa.wait_for_selector('#lgo',timeout=8000)
    pa.fill('#lnm','مدير الاختبار'); pa.fill('#lpw','wrong-pass'); pa.click('#lgo'); pa.wait_for_timeout(600)
    ok('wrong admin password rejected', 'كلمة السر غلط' in pa.inner_text('#lms'))
    ok('no admin token after wrong password', pa.evaluate("sessionStorage.getItem('at')") is None)
    pa.fill('#lpw','Marim*'); pa.click('#lgo'); pa.wait_for_selector('#adm details',timeout=8000); pa.wait_for_timeout(800)
    ok('admin panel opened with token', pa.evaluate("!!sessionStorage.getItem('at')"))
    ok('admin API refuses no token', api(pa,'/api/admin/stats')['s']==401)
    ok('admin API refuses customer/garbage token', api(pa,'/api/admin/stats',headers={'authorization':'Bearer abc.def'})['s']==401)
    # stats cards present (4 cards only)
    cards=pa.eval_on_selector_all('#smg .smc','e=>e.map(x=>x.querySelector("small").textContent)')
    ok('admin shows exactly 4 stat cards', cards[:1]==['عدد الزيارات'] and len(cards)==4 and cards[1:]==['عدد الطلبات','الفواتير المؤكدة','الفواتير غير المؤكدة'],cards)
    # ---------- C. admin gallery upload ----------
    pa.click('#adm details[data-t^="معرض الأعمال"] > summary'); pa.wait_for_timeout(300)
    pa.set_input_files("input[type=file][onchange*=\"gUp(this,'g','0')\"]",['/tmp/img01.jpg','/tmp/img02.jpg','/tmp/img03.jpg'])
    wf(pa,"document.getElementById('pubs')&&/تم النشر/.test(document.getElementById('pubs').textContent)",20000)
    ok('3 images saved to server DB', q('select count(*) from images')[0][0]>=3)
    st=json.loads(q("select v from kv where k='studio'")[0][0])['state']
    g0=[x for x in st['gal'] if x['cat']=='g' and x.get('tr')==0]
    ok('gallery rows linked to specialty+section (g / tier 0)', len(g0)==3, g0[:1])
    ok('gallery rows reference /img ids not base64', all(not str(x['img']).startswith('data:') for x in st['gal']))
    ok('hero slides migrated off base64', all(not str(x).startswith('data:') for x in st['slides']))
    ok('state on server has no admin hash', 'ph' not in st['cfg'])
    # cap: 11 files into section 1 -> only 10
    pa.set_input_files("input[type=file][onchange*=\"gUp(this,'g','1')\"]",[f'/tmp/img{i:02d}.jpg' for i in range(1,12)])
    poll(lambda: len(gal('g',1))==10 and any('الحد 10' in d for d in DLG)); pa.wait_for_timeout(2500)
    ok('section capped at 10 images', len(gal('g',1))==10, len(gal('g',1)))
    ok('cap warning shown', any('الحد 10' in d for d in DLG), DLG[-2:])
    # edit fields on first image
    first=pa.locator('#adm details[data-t^="معرض الأعمال"] .ge').first
    first.locator('input[placeholder="الاسم"]').fill('جدارية فضاء'); first.locator('input[placeholder="الاسم"]').press('Tab')
    first.locator('input[placeholder^="السعر"]').fill('450 ج/م²'); first.locator('input[placeholder^="السعر"]').press('Tab')
    first.locator('input[placeholder^="المقاس"]').fill('3×2.5 م'); first.locator('input[placeholder^="المقاس"]').press('Tab')
    first.locator('input[placeholder="الخامات المستخدمة"]').fill('أكريليك وسبراي'); first.locator('input[placeholder="الخامات المستخدمة"]').press('Tab')
    first.locator('textarea[placeholder="شرح التصميم"]').fill('جدارية فضائية بألوان زاهية'); first.locator('textarea[placeholder="شرح التصميم"]').press('Tab')
    first.locator('input[placeholder="تفاصيل إضافية"]').fill('تشطيب لامع'); first.locator('input[placeholder="تفاصيل إضافية"]').press('Tab')
    pa.wait_for_timeout(2600)
    st=json.loads(q("select v from kv where k='studio'")[0][0])['state']
    f1=[x for x in st['gal'] if x['cat']=='g' and x.get('tr')==0][0]
    ok('image data fields saved (name/price/size/materials/desc/extra)', f1.get('t')=='جدارية فضاء' and f1.get('sz')=='3×2.5 م' and f1.get('m')=='أكريليك وسبراي' and f1.get('ds')=='جدارية فضائية بألوان زاهية' and f1.get('x')=='تشطيب لامع' and f1.get('p')=='450 ج/م²', f1)
    # delete one image
    pa.locator('#adm details[data-t^="معرض الأعمال"] .ge').nth(2).locator('button:has-text("حذف")').click(); pa.wait_for_timeout(1500)
    st=json.loads(q("select v from kv where k='studio'")[0][0])['state']
    ok('delete image persisted', len([x for x in st['gal'] if x['cat']=='g' and x.get('tr')==0])==2)
    # tableau designs (uploaded while admin page is active)
    pa.set_input_files("input[type=file][onchange*=\"gUp(this,'t','0')\"]",['/tmp/img05.jpg','/tmp/img06.jpg'])
    end=time.time()+40
    while time.time()<end:
        st=json.loads(q("select v from kv where k='studio'")[0][0])['state']
        if len([x for x in st['gal'] if x['cat']=='t'])>=2: break
        time.sleep(.4)
    pa.wait_for_timeout(1500)
    tid=pa.evaluate("S.gal.filter(x=>x.cat=='t')[0].id"); pa.evaluate(f"gSet('{tid}','p','900 ج');gSet('{tid}','t','تابلوه الاختبار')"); pa.wait_for_timeout(3000)
    ok('tableau designs uploaded with price', len([x for x in json.loads(q("select v from kv where k='studio'")[0][0])['state']['gal'] if x['cat']=='t'])==2)
    # ---------- D. customer (already open before upload) reloads: sees images without any file deploy ----------
    pc.reload(); pc.wait_for_timeout(1800)
    pc.click('#sv > div[data-c="g"]'); pc.wait_for_selector('#gal .gi img',timeout=8000); pc.wait_for_timeout(800)
    info=pc.evaluate("[...document.querySelectorAll('#gal .gi img')].map(i=>[i.naturalWidth,i.getAttribute('src')])")
    ok('customer sees uploaded images after reload (no redeploy)', len(info)==12 and all(w>0 for w,_ in info), info[:2])
    ok('images served from /img/<id>', all(s.startswith('/img/') for _,s in info))
    chips=pc.eval_on_selector_all('#gal .chip','e=>e.map(x=>x.textContent.trim())')
    ok('sections shown as filter chips (existing names)', chips[0]=='الكل' and 'لون واحد' in ' '.join(chips), chips)
    pc.locator('#gal .gi:has-text("جدارية فضاء")').first.click(); pc.wait_for_selector('#itm',timeout=5000); pc.wait_for_timeout(400)
    txt=pc.inner_text('#itm')
    ok('design detail shows name/size/materials/desc/extra/price', all(k in txt for k in ['جدارية فضاء','3×2.5 م','أكريليك وسبراي','جدارية فضائية بألوان زاهية','تشطيب لامع','450 ج/م²']), txt[:300])
    ok('order buttons still available in detail', 'اطلب تنفيذ زي ده' in txt and 'طلب دمج واقعي' in txt)
    pc.evaluate("closeO('itm');closeO('gal')")
    # image headers
    iid=info[0][1]; r=api(pc,iid) if False else None
    resp=pc.request.get(BASE+iid); ok('image http 200 image/jpeg, immutable cache', resp.status==200 and resp.headers['content-type']=='image/jpeg' and 'immutable' in resp.headers['cache-control'])
    ok('api/studio not cacheable', 'no-store' in pc.request.get(BASE+'/api/studio').headers['cache-control'])
    ok('index.html no-cache', 'no-cache' in pc.request.get(BASE+'/').headers['cache-control'])
    # ---------- E. persistence across server restart (simulates redeploy of static file) ----------
    srv.terminate(); srv.wait(); srv=start()
    c2=new_ctx(br); p2=new_page(c2,'cust2'); p2.goto(BASE); skip_auth(p2); p2.wait_for_timeout(1500)
    p2.click('#sv > div[data-c="g"]'); p2.wait_for_selector('#gal .gi img'); p2.wait_for_timeout(600)
    n2=p2.evaluate("[...document.querySelectorAll('#gal .gi img')].filter(i=>i.naturalWidth>0).length")
    ok('images persist after server restart / new visitor', n2==12, n2); c2.close()
    # ---------- F. invoices & isolation ----------
    def order(page,tok,name,phone):
        page.goto(BASE); page.wait_for_timeout(500)
        if page.locator('#ask').count(): page.click('#ask')
        page.evaluate(f"finishReg({{name:'{name}',email:'{name}@x.com',via:'google',at:'{tok}'}})"); wf(page,"!!localStorage.getItem('st')",8000)
        page.evaluate("closeO('wel')")
        page.evaluate(f"setTimeout(()=>waSend('طلب استفسار (بدون دفع)\\nالاسم: {name}\\nالموبايل: {phone}\\nالنوع: Gravity - لون واحد\\nالمقاس: 3×2.5 م\\nالإجمالي التقريبي: ٣٬٣٧٥ ج\\nالعربون: ٦٧٥ ج'),0)")
        page.wait_for_url('**wa.me/**',timeout=10000)
    ca=new_ctx(br); pA=new_page(ca,'A'); order(pA,'tokA','a','01011111111')
    cb=new_ctx(br); pB=new_page(cb,'B'); order(pB,'tokB','b','01022222222')
    nos=[r[0] for r in q('select no from invoices order by id')]
    ok('server-generated sequential invoice numbers', nos==['INV-1001','INV-1002'], nos)
    own=q('select no,owner from invoices order by id'); ok('invoices bound to verified google identity', own==[('INV-1001','g:a@x.com'),('INV-1002','g:b@x.com')], own)
    def open_card(page):
        page.goto(BASE); page.wait_for_timeout(500)
        if page.locator('#ask').count(): page.click('#ask')
        page.click('#myinv'); page.wait_for_selector('#inv .iv',timeout=6000); return page.inner_text('#inv')
    tA=open_card(pA); tB=open_card(pB)
    ok('card A shows only INV-1001', 'INV-1001' in tA and 'INV-1002' not in tA and '01022222222' not in tA)
    ok('card B shows only INV-1002', 'INV-1002' in tB and 'INV-1001' not in tB and '01011111111' not in tB)
    ok('unpaid invoice hides download/share', 'تنزيل الفاتورة' not in tA and 'بيتفتحوا بعد تأكيد الدفع' in tA)
    cards_home=pA.evaluate("[...document.querySelectorAll('.act .ac')].map(e=>e.textContent)")
    pA.evaluate("closeO('inv')")
    ok('one invoice card only (no مدفوعاتي / تابع أوردرك) + chat card', len(cards_home)==2 and 'شات الذكاء' in cards_home[0] and 'فاتورت' in cards_home[1] and 'مدفوعاتي' not in pA.inner_text('body'), cards_home)
    tokA=pA.evaluate("localStorage.getItem('st')"); tokB=pB.evaluate("localStorage.getItem('st')")
    rA=api(pA,'/api/my-invoice',headers={'x-session':tokA}); rB=api(pA,'/api/my-invoice',headers={'x-session':tokB})
    ok('API: token A -> A only', rA['j']['invoice']['no']=='INV-1001' and rB['j']['invoice']['no']=='INV-1002')
    ok('API: no/forged session -> 401', api(pA,'/api/my-invoice')['s']==401 and api(pA,'/api/my-invoice',headers={'x-session':tokA[:-3]+'xxx'})['s']==401)
    ok('API: customer token cannot call admin', api(pA,'/api/admin/confirm','POST',{'authorization':'Bearer '+tokA,'content-type':'application/json'},{'no':'INV-1002'})['s']==401)
    ok('API: customer cannot publish content', api(pA,'/api/admin/studio','PUT',{'x-session':tokA,'content-type':'application/json'},{'state':{'cats':[]}})['s']==401)
    ok('invoice response has no other customers fields', set(rA['j']['invoice'].keys())>={'no','status'} and 'owner' not in rA['j']['invoice'])
    # fresh customer with no invoice
    cc=new_ctx(br); pC=new_page(cc,'C'); pC.goto(BASE); skip_auth(pC); pC.wait_for_timeout(500); pC.click('#myinv'); pC.wait_for_selector('#inv .iv')
    ok('empty state message', 'لسه مفيش فاتورة مرتبطة بحسابك. أول ما يتم إصدار فاتورة لطلبك هتظهر هنا' in pC.inner_text('#inv'))
    # ---------- G. admin confirm ----------
    pa.reload(); pa.wait_for_selector('#lgo'); pa.fill('#lpw','Marim*'); pa.fill('#lnm','مدير الاختبار'); pa.click('#lgo'); pa.wait_for_selector('#smg',timeout=8000); pa.wait_for_timeout(800)
    pend=pa.inner_text('#lgl'); ok('admin sees pending invoice numbers', 'INV-1001' in pend and 'INV-1002' in pend)
    pa.fill('#ivn','INV-9999'); pa.click('#ivb'); pa.wait_for_timeout(700)
    ok('unknown invoice number rejected', 'غير موجود' in pa.inner_text('#ivr'))
    pa.fill('#ivn','inv-1001'); pa.click('#ivb'); pa.wait_for_timeout(900)
    row=q("select status,confirmed_at,confirmed_by from invoices where no='INV-1001'")[0]
    ok('confirm: status+date+admin recorded in DB', row[0]=='confirmed' and row[1] and row[2]=='مدير الاختبار', row)
    ok('other invoice untouched', q("select status from invoices where no='INV-1002'")[0][0]=='pending')
    ok('admin UI shows confirmation', 'تم تأكيد الدفع' in pa.inner_text('#ivr'))
    pa.fill('#ivn','INV-1001'); pa.click('#ivb'); pa.wait_for_timeout(700)
    ok('re-confirm is idempotent', 'مؤكدة قبل كده' in pa.inner_text('#ivr') and q("select count(*) from invoices where status='confirmed'")[0][0]==1)
    tA2=open_card(pA); tB2=open_card(pB)
    ok('customer A sees paid state + download/share', 'تم الدفع' in tA2 and 'تنزيل الفاتورة' in tA2 and 'مشاركة الفاتورة' in tA2, tA2[:150])
    ok('customer B still unpaid, no download', 'تنزيل الفاتورة' not in tB2 and 'تم الدفع ✅' not in tB2)
    # ---------- H. stats ----------
    pa.reload(); pa.wait_for_selector('#lgo'); pa.fill('#lpw','Marim*'); pa.click('#lgo'); pa.wait_for_selector('#smg',timeout=8000); pa.wait_for_timeout(900)
    vals=pa.eval_on_selector_all('#smg .smc','e=>e.map(x=>x.querySelector("b").textContent.trim())')
    nums=[int(v.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789'))) for v in vals]
    dbv=q('select count(*) from visits')[0][0]
    ok('stat cards match DB (visits/orders/confirmed/unconfirmed)', nums==[dbv,2,1,1], (nums,dbv))
    vtxt=pa.inner_text('#smg .smc >> nth=0'); ok('visits card shows approximate location', 'Cairo' in vtxt, vtxt)
    ok('no extra tables/charts in stats card', pa.locator('#smg canvas, #smg table').count()==0)
    # ---------- I. location prompt behaviour ----------
    vs=q('select dev,lat,lng,city,country from visits'); 
    granted=[v for v in vs if v[1] is not None]; ok('granted visitor: coarse (2-decimal) coords stored', granted and all(abs(v[1]*100-round(v[1]*100))<1e-6 for v in granted) and abs(granted[0][1]-30.04)<0.01, vs)
    ok('IP-based approx location stored for all visits', all(v[3]=='Cairo' and v[4]=='EG' for v in vs))
    den=new_ctx(br); pD=new_page(den,'denied'); pD.goto(BASE); skip_auth(pD); pD.wait_for_timeout(1500)
    ok('denied location: app works, flag set, no blocking dialog', pD.evaluate("localStorage.getItem('locNo')")=='1' and not any('الموقع' in d for d in DLG))
    pD.click('#sv > div[data-c="t"]'); pD.wait_for_selector('#gal',timeout=5000); ok('denied location: browsing works', True)
    ok('denied visitor visit recorded without coords', q("select count(*) from visits where lat is null")[0][0]>=1)

    # ---------- K. round-2 features ----------
    # Google button + professional logo, never stuck on "preparing"
    gc=new_ctx(br); pG=new_page(gc,'G'); pG.goto(BASE); pG.wait_for_selector('#gsb'); pG.wait_for_timeout(600)
    ok('Google button: official 4-colour logo + clear label, enabled', pG.locator('#gsb svg path').count()==4 and 'المتابعة باستخدام Google' in pG.inner_text('#gsb') and pG.evaluate("!document.getElementById('gsb').disabled"))
    n0=len(DLG); pG.click('#gsb'); pG.wait_for_timeout(1500)
    ok('Google unavailable -> clear message (no endless spinner)', any('Google' in d for d in DLG[n0:]) and pG.evaluate("!document.getElementById('gsb').disabled"), DLG[n0:])
    # card styling/icons
    ic=pG.evaluate("(()=>{const q=s=>document.querySelector(s);return {gi:getComputedStyle(q('#sv div[data-c=\"g\"] .ic')).backgroundImage,gsvg:q('#sv div[data-c=\"g\"] svg').innerHTML.includes('#FF3D71'),rsvg:q('#sv div[data-c=\"r\"] svg').innerHTML.includes('ellipse')}})()")
    ok('graffiti card colourful + sculpture icon is a statue bust', 'gradient' in ic['gi'] and ic['gsvg'] and ic['rsvg'], ic)
    # mandatory Google for any order
    pG.click('#ask'); pG.wait_for_timeout(300)
    pG.evaluate("setTimeout(()=>waSend('طلب استفسار (بدون دفع)\\nالاسم: g\\nالموبايل: 01033333333\\nالنوع: x\\nالمقاس: 1×1 م\\nالإجمالي: ١٠٠ ج'),0)"); pG.wait_for_selector('#gate',timeout=5000)
    ok('order without Google -> sign-in gate shown, nothing created', q("select count(*) from invoices where phone='01033333333'")[0][0]==0 and pG.locator('#gate #gsb').count()==1)
    pG.evaluate("finishReg({name:'g',email:'a@x.com',via:'google',at:'tokA'})"); pG.wait_for_url('**wa.me/**',timeout=10000)
    ok('after Google sign-in the pending order resumes automatically', q("select count(*) from invoices where phone='01033333333'")[0][0]==1)
    # AI chat card
    cc2=new_ctx(br); pH=new_page(cc2,'chat'); pH.goto(BASE); skip_auth(pH); pH.wait_for_timeout(800)
    ok('home has AI chat card + single invoice card', pH.locator('#aichat').count()==1 and 'شات الذكاء الاصطناعي' in pH.inner_text('#aichat') and pH.locator('.act .ac').count()==2)
    pH.click('#aichat'); pH.wait_for_selector('#cinp'); pH.fill('#cinp','كام سعر الغرافيتي؟'); pH.click('#csend'); pH.wait_for_selector('.cm.b:has-text("رد تجريبي")',timeout=8000)
    rt=pH.inner_text('#cmsgs'); ok('chat answers via fallback provider (first provider down)', 'sys:ok' in rt and 'rec:' in rt, rt[-120:])
    r=api(pH,'/api/chat','POST',{'content-type':'application/json'},{'messages':[{'role':'user','content':'hi'}]}); ok('chat API provider fail-over: groq(500) -> pollinations', r['s']==200 and r['j'].get('provider')=='pollinations', r)
    ok('chat rejects bad input', api(pH,'/api/chat','POST',{'content-type':'application/json'},{'messages':[]})['s']==400)
    last=0
    for _ in range(25): last=api(pH,'/api/chat','POST',{'content-type':'application/json'},{'messages':[{'role':'user','content':'x'}]})['s']
    ok('chat rate-limited per IP', last==429, last)
    # music
    pH.evaluate("closeO('chat')"); ok('music button present', pH.locator('#musb').count()==1)
    ok('music auto-starts after first interaction', pH.evaluate("__mus.on"))
    pH.click('#musb'); pH.wait_for_timeout(300); ok('music can be turned off and choice persists', pH.evaluate("!__mus.on&&localStorage.getItem('mus')=='0'"))
    pH.click('#musb'); pH.wait_for_timeout(500); ok('music can be turned back on', pH.evaluate("__mus.on&&localStorage.getItem('mus')=='1'"))
    # tableau wizard end-to-end (needs Google) + floating images card + card states
    ct=new_ctx(br); pT=new_page(ct,'tab'); pT.goto(BASE); skip_auth(pT); pT.wait_for_timeout(1200)
    pT.click('#sv > div[data-c="t"]'); pT.wait_for_selector('#gal button:has-text("احجز تابلوه")'); pT.click('#gal button:has-text("احجز تابلوه")'); pT.wait_for_selector('#gate',timeout=5000)
    ok('Tableau booking requires Google first', pT.locator('#gate').count()==1)
    pT.evaluate("finishReg({name:'tab',email:'b@x.com',via:'google',at:'tokB'})"); pT.wait_for_selector('#tb',timeout=8000)
    print('DBG step1 gi:',pT.locator('#tb .gi').count(),pT.inner_text('#tb .sh-h'),'| methods:',pT.evaluate("MT.map(m=>m[0]+':'+!!S.cfg[m[0]]).join(',')") if False else '')
    ok('Tableau step 1: only studio designs listed', pT.locator('#tb .gi').count()==2 and 'من 3' in pT.inner_text('#tb .sh-h'))
    pT.click('#tb .gi >> nth=0'); pT.wait_for_timeout(300); pT.click('#tb button:has-text("التالي")'); pT.wait_for_timeout(200)
    ok('size is required', 'المقاس' in pT.inner_text('#tbm'))
    pT.fill('#tbw','80'); pT.fill('#tbh','120'); pT.click('#tb button:has-text("التالي")'); pT.wait_for_timeout(300)
    ok('Tableau step 2: wall photos optional (skip available)', 'تخطي' in pT.inner_text('#tb'))
    pT.click('#tb button:has-text("تخطي")'); pT.wait_for_timeout(300)
    print('DBG step3:',pT.inner_text('#tb')[:400].replace(chr(10),' | '))
    ok('Tableau step 3: payment channels + price + 50% deposit', pT.locator('#tb .tbo').count()>=1 and '٤٥٠' in pT.inner_text('#tb'), pT.inner_text('#tb')[:200])
    pT.fill('#tn','tab'); pT.fill('#tp','01044444444'); pT.fill('#tc','القاهرة'); pT.fill('#ta','شارع 1'); pT.click('#tb .tbo >> nth=0'); pT.click('#tb button:has-text("تأكيد الحجز")'); pT.wait_for_url('**wa.me/**',timeout=10000)
    row=q("select no,kind,size,total,dep,design from invoices where phone='01044444444'"); ok('tableau invoice stored with size/price/deposit', row and row[0][1]=='booking' and row[0][2]=='80×120 سم' and row[0][3]==900 and row[0][4]==450, row)
    pT.goto(BASE); pT.wait_for_selector('#st2',timeout=8000)
    ok('floating images card appears + card becomes «فاتورتك»', pT.locator('#st2').count()==1 and pT.inner_text('#myinv b')=='فاتورتك', pT.inner_text('#myinv b'))
    pT.bring_to_front(); pT.set_input_files('#st2 input[type=file]',['/tmp/img07.jpg'])
    try: wf(pT,"document.querySelectorAll('#st2 .st2i img').length==1",8000)
    except Exception: pass
    ok('transfer photo can be added from the floating card', pT.locator('#st2 .st2i img').count()==1)
    pT.evaluate("step2Sent()"); pT.wait_for_timeout(300); ok('images need explicit confirmation', 'اتبعتت' in pT.inner_text('#st2'))
    pT.evaluate("step2Done()"); pT.wait_for_timeout(400)
    ok('after confirmation: card becomes «تابع فاتورتك», bar gone', pT.locator('#st2').count()==0 and pT.inner_text('#myinv b')=='تابع فاتورتك')
    pT.click('#myinv'); pT.wait_for_selector('#inv .iv'); ok('tableau invoice opens from card', row[0][0] in pT.inner_text('#inv'))
    # admin: music URL field + password works
    ok('admin login with Marim*', pa.evaluate("!!sessionStorage.getItem('at')"))
    # ---------- J. hygiene ----------
    for nm,pg in [('cust',pc),('admin',pa),('A',pA),('C',pC),('D',pD),('G',pG),('chat',pH),('tab',pT)]:
        d=pg.evaluate("(()=>{const m={};document.querySelectorAll('[id]').forEach(e=>m[e.id]=(m[e.id]||0)+1);return Object.keys(m).filter(k=>m[k]>1)})()")
        ok(f'no duplicate DOM ids ({nm})', not d, d)
    errs=[e for e in ERR if 'Failed to load resource' not in e[2]]
    ok('no JavaScript errors in any page', not errs, errs[:5])
    br.close()
srv.terminate()
bad=[r for r in RES if not r[1]]
print(f'\n{len(RES)-len(bad)}/{len(RES)} passed'); sys.exit(1 if bad else 0)
