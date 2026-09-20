import express from 'express';
import {fileURLToPath} from 'node:url';
import {applyCapabilities} from './engine/transform';
import type {CapabilityProfile} from './engine/ast';
import {Store, validateConfig} from './store';

export function createApp(store = new Store()){
  const app=express();
  app.use(express.json({limit:'2mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:'email-rendering',templates:store.templates.length,profiles:store.profiles.length}));

  // ---- 模板 ----
  app.get('/api/templates',(_req,res)=>res.json(store.templates.map(({content,...row})=>row)));
  app.get('/api/templates/:id',(req,res)=>{
    const row=store.getTemplate(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });
  app.put('/api/templates/:id',(req,res)=>{
    const row=store.getTemplate(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(typeof req.body.revision!=='number')return res.status(400).json({error:'revision_required'});
    const result=store.saveTemplate(row.id,String(req.body.content??''),req.body.revision);
    if(!result.ok)return res.status(result.status).json({error:result.error,current:result.current});
    res.json(result.row);
  });
  app.post('/api/templates/:id/analyze',(req,res)=>{
    const row=store.getTemplate(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const content=typeof req.body.content==='string'?req.body.content:row.content;
    res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,diagnostics:[]});
  });

  // ---- 能力配置（版本化 + 软删除 + 历史快照） ----
  const profileSummary = (p:typeof store.profiles[number]) => ({
    id:p.id,name:p.name,revision:p.revision,updatedAt:p.updatedAt,deletedAt:p.deletedAt,
  });
  app.get('/api/profiles',(_req,res)=>res.json(store.profiles.map(profileSummary)));
  app.get('/api/profiles/:id',(req,res)=>{
    const row=store.getProfile(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const rev=req.query.revision!=null?Number(req.query.revision):row.revision;
    const snap=store.getProfileRevision(row.id,rev);
    if(!snap)return res.status(404).json({error:'revision_not_found'});
    // 即使配置被软删除，历史快照依旧可读
    res.json({...profileSummary(row),revision:snap.revision,config:snap.config});
  });
  app.put('/api/profiles/:id',(req,res)=>{
    const existing=store.getProfile(req.params.id);
    const base=typeof req.body.revision==='number'
      ? req.body.revision
      : existing?existing.revision:0;
    const name=typeof req.body.name==='string'&&req.body.name.trim()?req.body.name:req.params.id;
    const checked=validateConfig(req.body.config);
    if(!checked.ok)return res.status(400).json({error:checked.error});
    const result=store.saveProfile(req.params.id,name,checked.config as CapabilityProfile,base);
    if(!result.ok){
      const body:Record<string,unknown>={error:result.error};
      if('current'in result&&result.current)body.current=profileSummary(result.current);
      return res.status(result.status).json(body);
    }
    res.json(profileSummary(result.row));
  });
  app.delete('/api/profiles/:id',(req,res)=>{
    const result=store.deleteProfile(req.params.id);
    if(!result.ok)return res.status(result.status).json({error:result.error});
    res.json(profileSummary(result.row));
  });

  // ---- 降级预览：模板 × 配置 revision ----
  // 绑定规则：必须显式传 profileRevision；服务端取该 revision 的配置快照执行转换。
  // 配置事后被修改/删除，不影响按旧 revision 渲染出的历史预览。
  app.post('/api/templates/:id/preview',(req,res)=>{
    const row=store.getTemplate(req.params.id);
    if(!row)return res.status(404).json({error:'template_not_found'});
    const profileId=String(req.body.profileId??'');
    const profileRevision=Number(req.body.profileRevision);
    if(!profileId||!Number.isInteger(profileRevision))return res.status(400).json({error:'profile_revision_required'});
    const profile=store.getProfile(profileId);
    if(!profile)return res.status(404).json({error:'profile_not_found'});
    const snap=store.getProfileRevision(profileId,profileRevision);
    if(!snap)return res.status(404).json({error:'profile_revision_not_found'});
    const content=typeof req.body.content==='string'?req.body.content:row.content;
    const result=applyCapabilities(content,snap.config,{
      shuffleSeed:typeof req.body.shuffleSeed==='number'?req.body.shuffleSeed:undefined,
    });
    res.json({
      templateId:row.id,
      templateRevision:row.revision,
      profile:{id:profile.id,name:profile.name,revision:snap.revision,deletedAt:profile.deletedAt},
      configVersion:snap.config.version,
      snapshot:profile.deletedAt!==null,
      original:{
        html:result.original.html,
        ranges:Object.fromEntries(result.original.ranges),
        sheetRanges:Object.fromEntries([...result.original.sheetRanges].map(([k,v])=>[k,{sheetId:v.sheetId,ranges:Object.fromEntries(v.ranges)}])),
        inlineRanges:Object.fromEntries([...result.original.inlineRanges].map(([k,m])=>[k,Object.fromEntries(m)])),
      },
      transformed:{
        html:result.transformed.html,
        ranges:Object.fromEntries(result.transformed.ranges),
        sheetRanges:Object.fromEntries([...result.transformed.sheetRanges].map(([k,v])=>[k,{sheetId:v.sheetId,ranges:Object.fromEntries(v.ranges)}])),
        inlineRanges:Object.fromEntries([...result.transformed.inlineRanges].map(([k,m])=>[k,Object.fromEntries(m)])),
      },
      explanations:result.explanations,
    });
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
