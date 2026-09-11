import { neon } from '@neondatabase/serverless';

const json=(res,status,body)=>res.status(status).json(body);
const safeMember=(m)=>{ if(!m)return null; const {password,...safe}=m; return safe; };
const normalizePhone=(v)=>String(v||'').replace(/\s/g,'');
function parseDate(v){if(!v)return null;const d=new Date(`${String(v).slice(0,10)}T00:00:00`);return Number.isNaN(d.getTime())?null:d;}
const formatDateOnly=(d)=>d.toISOString().slice(0,10);
function addMonths(date,months){const d=new Date(date);const day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+Number(months||0));const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return d;}
function expiryFromPurchase(date,months){const d=addMonths(parseDate(date),months);d.setDate(d.getDate()-1);return formatDateOnly(d);}
function detectCreditProduct(product){const text=[product?.name,product?.title,product?.productName,product?.description,product?.id,product?.sku].filter(Boolean).join(' ').toLowerCase();const amount=Number(product?.creditAmount??product?.credit??product?.credit_value??product?.amount??0);if(amount===388||text.includes('388'))return{creditAmount:388,validityMonths:12};if(amount===688||text.includes('688'))return{creditAmount:688,validityMonths:24};if(text.includes('credit'))return{creditAmount:Number.isFinite(amount)&&amount>0?amount:0,validityMonths:Number(product?.validityMonths||product?.validity||12)};return null;}
function getCreditLots(member){const lots=Array.isArray(member?.creditLots)?member.creditLots:[];return lots.map(lot=>({id:String(lot.id||`CREDIT-${member.id}-${lot.purchaseDate||Date.now()}`),productId:String(lot.productId||''),productName:String(lot.productName||'Credit'),originalAmount:Number(lot.originalAmount||0),balance:Number(lot.balance||0),purchaseDate:lot.purchaseDate||null,expiry:lot.expiry||null,invoiceNo:lot.invoiceNo||'',validityMonths:Number(lot.validityMonths||0)})).filter(l=>l.balance>0||l.originalAmount>0);}
function ensureLegacyCreditLot(member){const lots=getCreditLots(member);if(!lots.length&&Number(member?.credit||0)>0){const amount=Number(member.credit);lots.push({id:`PREVIOUS-${member.id}`,productId:'',productName:'Previous Credit Balance',originalAmount:amount,balance:amount,purchaseDate:null,expiry:null,invoiceNo:'',validityMonths:0});member.creditLots=lots;}return lots;}
function totalCreditBalance(member){const lots=getCreditLots(member);if(!lots.length)return Math.max(0,Number(member?.credit||0));const today=formatDateOnly(new Date());return lots.filter(l=>!l.expiry||l.expiry>=today).reduce((s,l)=>s+Math.max(0,Number(l.balance||0)),0);}
async function save(sql,data){await sql`INSERT INTO musco_store(id,data) VALUES('main',${JSON.stringify(data)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`;}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    if(!process.env.DATABASE_URL)return json(res,500,{error:'DATABASE_URL is not configured'});
    const sql=neon(process.env.DATABASE_URL);
    const rows=await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
    const data=rows[0]?.data||{products:[],members:[],orders:[],settings:{}};
    data.products=Array.isArray(data.products)?data.products:[];data.members=Array.isArray(data.members)?data.members:[];data.orders=Array.isArray(data.orders)?data.orders:[];data.settings=data.settings||{};
    if(req.method==='GET'){
      const members=data.members.map(m=>{const safe=safeMember(m);safe.credit=totalCreditBalance(m);safe.creditLots=getCreditLots(m);return safe;});
      const credits=[];for(const m of data.members)for(const lot of getCreditLots(m))if(lot.balance>0)credits.push({id:lot.id,memberId:m.id,date:lot.purchaseDate,type:'Credit',amount:lot.balance,originalAmount:lot.originalAmount,expiry:lot.expiry,productId:lot.productId,productName:lot.productName,invoiceNo:lot.invoiceNo});
      return json(res,200,{members,credits});
    }
    if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):req.body||{};

    if(body.action==='login'){
      const phone=String(body.phone||'').trim(),password=String(body.password||'');
      if(!phone||!password)return json(res,400,{error:'Phone and password are required.'});
      const member=data.members.find(x=>normalizePhone(x.phone)===normalizePhone(phone));
      if(!member)return json(res,404,{error:'电话号码不存在，请先 Create Account'});
      if(String(member.password||'')!==password)return json(res,401,{error:'Password 错误'});
      return json(res,200,{member:{...safeMember(member),credit:totalCreditBalance(member),creditLots:getCreditLots(member)},credit:totalCreditBalance(member)});
    }

    if(body.action==='member'){
      const m=body.member||{},id=String(m.id||'').trim(),name=String(m.name||'').trim(),phone=String(m.phone||'').trim();
      if(!id||!name||!phone)return json(res,400,{error:'Member ID, name and phone are required.'});
      const duplicate=data.members.find(x=>x.id!==id&&normalizePhone(x.phone)===normalizePhone(phone));if(duplicate)return json(res,409,{error:'这个电话号码已经注册，请直接 Login'});
      const existing=data.members.find(x=>x.id===id);
      const member={...(existing||{}),id,name,phone,email:String(m.email??existing?.email??'').trim().toLowerCase(),password:String(m.password??existing?.password??''),address:String(m.address??existing?.address??''),credit:totalCreditBalance(existing||m),creditLots:getCreditLots(existing||m)};
      data.members=existing?data.members.map(x=>x.id===id?member:x):[...data.members,member];await save(sql,data);return json(res,200,safeMember(member));
    }

    if(body.action==='addCredit'){
      const c=body.credit||{},memberId=String(c.memberId||'').trim(),member=data.members.find(x=>x.id===memberId);if(!member)return json(res,404,{error:'Member not found in cloud store'});
      const detected=detectCreditProduct(c.product||{}),creditAmount=Number(c.amount??detected?.creditAmount??0);if(!Number.isFinite(creditAmount)||creditAmount<=0)return json(res,400,{error:'Invalid credit amount'});
      const purchaseDate=String(c.invoiceDate||'').slice(0,10);const pd=parseDate(purchaseDate)?purchaseDate:formatDateOnly(new Date());const validityMonths=Number(c.validityMonths??detected?.validityMonths??12);let expiry=c.expiry?String(c.expiry).slice(0,10):null;if(!expiry)expiry=expiryFromPurchase(pd,validityMonths);
      const lot={id:String(c.id||`CREDIT-${memberId}-${Date.now()}`),productId:String(c.productId||c.product?.id||''),productName:String(c.productName||c.product?.name||c.product?.title||'Credit'),originalAmount:creditAmount,balance:creditAmount,purchaseDate:pd,expiry,invoiceNo:String(c.invoiceNo||''),validityMonths};
      const lots=ensureLegacyCreditLot(member);lots.push(lot);member.creditLots=lots;member.credit=totalCreditBalance(member);await save(sql,data);return json(res,200,{ok:true,lot,credit:member.credit,member:safeMember(member)});
    }

    if(body.action==='update_credit_expiry'){
      const c=body.credit||body,memberId=String(c.memberId||'').trim(),member=data.members.find(x=>x.id===memberId);if(!member)return json(res,404,{error:'Member not found in cloud store'});
      const invoiceNo=String(c.invoiceNo||'').trim(),invoiceDate=String(c.invoiceDate||'').slice(0,10);if(!invoiceNo||!parseDate(invoiceDate))return json(res,400,{error:'Invoice No and valid invoice date are required'});
      const lots=getCreditLots(member);const matched=lots.filter(x=>x.invoiceNo===invoiceNo);if(!matched.length)return json(res,404,{error:'Credit lot not found for invoice'});
      const requestedExpiry=String(c.expiry||'').slice(0,10);
      for(const lot of matched){
        const validityMonths=Number(c.validityMonths||lot.validityMonths||((Number(lot.originalAmount)===688)?24:(Number(lot.originalAmount)===388?12:12)));
        lot.purchaseDate=invoiceDate;lot.validityMonths=validityMonths;lot.expiry=parseDate(requestedExpiry)?requestedExpiry:expiryFromPurchase(invoiceDate,validityMonths);
      }
      member.creditLots=lots;member.credit=totalCreditBalance(member);await save(sql,data);return json(res,200,{ok:true,lot:matched[0],lots:matched,credit:member.credit,member:safeMember(member)});
    }

    if(body.action==='useCredit'){
      const memberId=String(body.memberId||body.credit?.memberId||'').trim(),requestedAmount=Number(body.amount??body.credit?.amount??0),member=data.members.find(x=>x.id===memberId);if(!member)return json(res,404,{error:'Member not found in cloud store'});if(!Number.isFinite(requestedAmount)||requestedAmount<=0)return json(res,400,{error:'Invalid credit amount'});
      const today=formatDateOnly(new Date());const lots=ensureLegacyCreditLot(member).filter(l=>l.balance>0).filter(l=>!l.expiry||l.expiry>=today).sort((a,b)=>(a.expiry||'9999-12-31').localeCompare(b.expiry||'9999-12-31'));let remaining=requestedAmount;const deductions=[];
      for(const lot of lots){if(remaining<=0)break;const before=Number(lot.balance||0),used=Math.min(before,remaining);lot.balance=Number((before-used).toFixed(2));remaining=Number((remaining-used).toFixed(2));deductions.push({lotId:lot.id,productId:lot.productId,productName:lot.productName,amountUsed:used,balanceAfter:lot.balance,expiry:lot.expiry});}
      if(remaining>0)return json(res,400,{error:`Insufficient active credit balance. Short by RM${remaining.toFixed(2)}`});member.creditLots=lots;member.credit=totalCreditBalance(member);await save(sql,data);return json(res,200,{ok:true,requestedAmount,deductions,credit:member.credit,member:safeMember(member)});
    }

    if(body.action==='credit'){
      const c=body.credit||{},memberId=String(c.memberId||'').trim(),amount=Number(c.amount||0),m=data.members.find(x=>x.id===memberId);if(!m)return json(res,404,{error:'Member not found in cloud store'});if(!Number.isFinite(amount)||amount===0)return json(res,400,{error:'Invalid credit amount'});
      const current=totalCreditBalance(m);if(current+amount<0)return json(res,400,{error:`Credit balance cannot be negative. Current balance: RM${current.toFixed(2)}`});
      if(amount>0){const lots=ensureLegacyCreditLot(m);lots.push({id:String(c.id||`LEGACY-${memberId}-${Date.now()}`),productId:String(c.productId||''),productName:String(c.productName||'Credit'),originalAmount:amount,balance:amount,purchaseDate:c.invoiceDate||formatDateOnly(new Date()),expiry:c.expiry?String(c.expiry).slice(0,10):null,invoiceNo:String(c.invoiceNo||''),validityMonths:Number(c.validityMonths||0)});m.creditLots=lots;}
      else{let rem=Math.abs(amount);const lots=ensureLegacyCreditLot(m).filter(l=>l.balance>0).sort((a,b)=>(a.expiry||'9999-12-31').localeCompare(b.expiry||'9999-12-31'));for(const lot of lots){if(rem<=0)break;const used=Math.min(Number(lot.balance||0),rem);lot.balance=Number((Number(lot.balance||0)-used).toFixed(2));rem=Number((rem-used).toFixed(2));}if(rem>0)return json(res,400,{error:`Credit balance cannot be reduced by RM${Math.abs(amount).toFixed(2)}`});m.creditLots=lots;}
      m.credit=totalCreditBalance(m);await save(sql,data);return json(res,200,{ok:true,credit:m.credit,member:safeMember(m)});
    }
    return json(res,400,{error:'Unknown action'});
  }catch(e){console.error('Members API error:',e);return json(res,500,{error:e?.message||'Database error'});}
}
