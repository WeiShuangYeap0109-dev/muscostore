import { neon } from '@neondatabase/serverless';

const json=(res,status,body)=>res.status(status).json(body);
const authAdmin=(body)=>{const a=body?.admin||{}; return !!process.env.ADMIN_PASSWORD && a.username===(process.env.ADMIN_USERNAME||'admin') && a.password===process.env.ADMIN_PASSWORD;};
const cleanMembers=(members=[])=>members.map(({password,...m})=>m);

export default async function handler(req,res){
  try{
    if(!process.env.DATABASE_URL) return json(res,500,{error:'DATABASE_URL is not configured'});
    const sql=neon(process.env.DATABASE_URL);
    const rows=await sql`SELECT data FROM musco_store WHERE id='main' LIMIT 1`;
    const data=rows[0]?.data||{products:[],members:[],orders:[],settings:{}};
    data.products=data.products||[]; data.members=data.members||[]; data.orders=data.orders||[]; data.settings=data.settings||{};

    if(req.method==='GET'){ const safe=JSON.parse(JSON.stringify(data)); safe.members=cleanMembers(safe.members); return json(res,200,{data:safe}); }
    if(req.method!=='POST') return json(res,405,{error:'Method not allowed'});
    const body=req.body||{};

    if(body.action==='completeOrder'){
      if(!authAdmin(body)) return json(res,401,{error:'Admin authorization required'});
      const order=data.orders.find(o=>o.invoiceNo===String(body.invoiceNo||''));
      if(!order) return json(res,404,{error:'Order not found'});
      if(order.status==='Completed' && order.invoiceGenerated) return json(res,200,{ok:true,data:{...data,members:cleanMembers(data.members)},order});
      for(const item of order.items||[]){ const p=data.products.find(x=>x.id===item.productId); if(!p) return json(res,400,{error:`商品不存在：${item.productName||item.productId}`}); if(Number(p.stock)<Number(item.qty)) return json(res,400,{error:`库存不足：${item.productName||item.productId}`}); }
      if(order.paymentMethod==='Member Credit'){
        const m=data.members.find(x=>x.id===order.memberId); if(!m) return json(res,400,{error:'会员不存在'});
        const use=Number(order.creditUsed||order.totalAmount||0); if(Number(m.credit)<use) return json(res,400,{error:`会员 Credit 余额不足 RM${m.credit}`}); m.credit=Number(m.credit)-use; order.creditDeducted=true;
      }
      for(const item of order.items||[]){ const p=data.products.find(x=>x.id===item.productId); p.stock=Math.max(0,Number(p.stock)-Number(item.qty)); }
      order.status='Processing'; order.invoiceGenerated=true; order.completedAt=new Date().toISOString();
      await sql`INSERT INTO musco_store (id,data) VALUES ('main',${JSON.stringify(data)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`;
      const safe=JSON.parse(JSON.stringify(data)); safe.members=cleanMembers(safe.members); const safeMember=data.members.find(m=>m.id===order.memberId); return json(res,200,{ok:true,data:safe,order,member:safeMember?((({password,...x})=>x)(safeMember)):null});
    }

    if(body.action==='addCredit'){
      if(!authAdmin(body)) return json(res,401,{error:'Admin authorization required'});
      const m=data.members.find(x=>x.id===String(body.memberId||'')); const amount=Number(body.amount);
      if(!m) return json(res,404,{error:'Member not found'}); if(!Number.isFinite(amount)||amount<=0) return json(res,400,{error:'Invalid credit amount'});
      m.credit=Number(m.credit||0)+amount;
      await sql`INSERT INTO musco_store (id,data) VALUES ('main',${JSON.stringify(data)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`;
      const safe=JSON.parse(JSON.stringify(data)); safe.members=cleanMembers(safe.members); const sm={...m}; delete sm.password; return json(res,200,{ok:true,data:safe,member:sm});
    }

    const {data:incoming}=body;
    if(!incoming) return json(res,400,{error:'Missing data'});
    if(body.admin && !authAdmin(body)) return json(res,401,{error:'Admin authorization required'});
    await sql`INSERT INTO musco_store (id,data) VALUES ('main',${JSON.stringify(incoming)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`;
    return json(res,200,{ok:true});
  }catch(e){ console.error(e); return json(res,500,{error:e.message||'Server error'}); }
}
