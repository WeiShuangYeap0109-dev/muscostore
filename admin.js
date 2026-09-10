export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const u=process.env.ADMIN_USERNAME || 'admin';
  const pw=process.env.ADMIN_PASSWORD;
  if(!pw) return res.status(500).json({error:'请在 Vercel 设置 ADMIN_PASSWORD'});
  const {username,password}=req.body||{};
  if(username===u && password===pw) return res.status(200).json({ok:true});
  return res.status(401).json({error:'密码错误'});
}
