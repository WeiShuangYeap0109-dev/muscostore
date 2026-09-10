import { neon } from '@neondatabase/serverless';
const out=(res,s,b)=>res.status(s).json(b);
export default async function handler(req,res){
  if(req.method!=='POST') return out(res,405,{error:'Method not allowed'});
  try{
    const sql=neon(process.env.DATABASE_URL); const body=req.body||{};
    const rows=await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
    const data=rows[0]?.data||{products:[],members:[],orders:[],settings:{}}; data.members=data.members||[];
    if(body.action==='login'){
      const id=String(body.identifier||'').trim().toLowerCase(), pass=String(body.password||'');
      const m=data.members.find(x=>((String(x.email||'').toLowerCase()===id)||(String(x.phone||'')===String(body.identifier||'').trim()))&&String(x.password||'')===pass);
      if(!m) return out(res,401,{error:'账号或密码错误'});
      const {password,...safe}=m; return out(res,200,{member:safe});
    }
    if(body.action==='register'){
      const email=String(body.email||'').trim().toLowerCase(), phone=String(body.phone||'').trim();
      if(!email&&!phone) return out(res,400,{error:'手机或邮箱至少填一个'});
      if(data.members.some(m=>(email&&String(m.email||'').toLowerCase()===email)||(phone&&String(m.phone||'')===phone))) return out(res,409,{error:'账号已存在'});
      const m={id:'m'+Date.now(),name:String(body.name||'').trim(),phone,email,password:String(body.password||''),credit:0};
      data.members.push(m);
      await sql`INSERT INTO musco_store (id,data) VALUES ('main',${JSON.stringify(data)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`;
      const {password,...safe}=m; return out(res,200,{member:safe});
    }
    return out(res,400,{error:'Invalid action'});
  }catch(e){console.error(e);return out(res,500,{error:e.message||'Server error'});}
}
