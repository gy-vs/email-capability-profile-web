import express from 'express';
import {fileURLToPath} from 'node:url';
import type {
  PreviewSummary,
  ProfileSummary,
  TemplateSummary,
} from '../shared/types';
import {validateConfig} from './capabilities';
import {
  createProfile,
  createStore,
  deleteProfile,
  getPreview,
  getProfile,
  getProfileRevision,
  listPreviews,
  listProfileRevisions,
  listProfiles,
  runPreview,
  updateProfile,
  updateTemplate,
} from './store';

export function createApp(){
  const store = createStore();
  const app = express();
  app.use(express.json({limit:'2mb'}));

  app.get('/api/bootstrap',(_req,res)=>
    res.json({family:'email-rendering', count: store.templates.length, profiles: store.profiles.length}));

  // --- Templates ---
  app.get('/api/templates',(_req,res)=>{
    const summaries: TemplateSummary[] = store.templates.map(({content: _content, ...row}) => row);
    res.json(summaries);
  });
  app.get('/api/templates/:id',(req,res)=>{
    const row=store.templates.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });
  app.put('/api/templates/:id',(req,res)=>{
    const row=store.templates.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const outcome = updateTemplate(store, row.id, String(req.body.content ?? ''), Number(req.body.revision));
    if (outcome.status === 409) return res.status(409).json({error:'revision_conflict', current: outcome.current});
    res.json(outcome.row);
  });
  app.post('/api/templates/:id/analyze',async(req,res)=>{
    const row=store.templates.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?5:2));
    const content=String(req.body.content ?? row.content);
    res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,diagnostics:[]});
  });

  // --- Capability profiles (versioned) ---
  app.get('/api/profiles',(_req,res)=>{
    const summaries: ProfileSummary[] = listProfiles(store).map(({config: _config, ...row}) => row);
    res.json(summaries);
  });
  app.post('/api/profiles',(req,res)=>{
    const id=String(req.body.id??'').trim().toLowerCase();
    const name=String(req.body.name??'').trim();
    if(!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id))return res.status(400).json({error:'invalid_id'});
    if(!name)return res.status(400).json({error:'invalid_name'});
    const parsed=validateConfig(req.body.config);
    if(parsed.errors.length)return res.status(400).json({error:'invalid_config',details:parsed.errors});
    const outcome=createProfile(store,id,name,parsed.config!);
    if(outcome.status===409)return res.status(409).json({error:'profile_exists'});
    res.status(201).json(outcome.record);
  });
  app.get('/api/profiles/:id/revisions',(req,res)=>{
    const revisions=listProfileRevisions(store,req.params.id);
    if(!revisions.length)return res.status(404).json({error:'not_found'});
    res.json(revisions.map(({config: _config, ...row}) => row));
  });
  app.get('/api/profiles/:id/revisions/:revision',(req,res)=>{
    const revision=Number(req.params.revision);
    const snapshot=getProfileRevision(store,req.params.id,revision);
    if(!snapshot)return res.status(404).json({error:'not_found'});
    res.json(snapshot);
  });
  app.get('/api/profiles/:id',(req,res)=>{
    const record=getProfile(store,req.params.id);
    if(!record)return res.status(404).json({error:'not_found'});
    res.json(record);
  });
  app.put('/api/profiles/:id',(req,res)=>{
    const record=getProfile(store,req.params.id);
    if(!record)return res.status(404).json({error:'not_found'});
    const name=String(req.body.name??record.name).trim();
    if(!name)return res.status(400).json({error:'invalid_name'});
    const parsed=validateConfig(req.body.config ?? record.config);
    if(parsed.errors.length)return res.status(400).json({error:'invalid_config',details:parsed.errors});
    const outcome=updateProfile(store,record.id,name,parsed.config!,Number(req.body.revision));
    if(outcome.status===409)return res.status(409).json({error:'revision_conflict',current:outcome.current});
    res.json(outcome.record);
  });
  app.delete('/api/profiles/:id',(req,res)=>{
    const deleted=deleteProfile(store,req.params.id);
    if(!deleted)return res.status(404).json({error:'not_found'});
    res.status(204).end();
  });

  // --- Previews: run against an explicit profile revision; snapshots retained forever ---
  app.post('/api/transform',(req,res)=>{
    const templateId=String(req.body.templateId??'');
    const profileId=String(req.body.profileId??'');
    const profileRevision=Number(req.body.profileRevision);
    const useDraft=req.body.useDraft===true;
    if(!Number.isInteger(profileRevision)||profileRevision<1){
      return res.status(400).json({error:'profile_revision_required',detail:'Selecting a profile revision is required so the preview is bound.'});
    }
    const content=typeof req.body.content==='string'?req.body.content:undefined;
    const outcome=runPreview(store,templateId,profileId,profileRevision,useDraft?content:undefined);
    if(outcome.status===404)return res.status(404).json({error:outcome.error});
    res.status(201).json(outcome.record);
  });
  app.get('/api/previews',(_req,res)=>{
    const summaries: PreviewSummary[] = listPreviews(store).map((p) => ({
      id:p.id, templateId:p.templateId, templateName:p.templateName, templateRevision:p.templateRevision,
      profileId:p.profileId, profileName:p.profileName, profileRevision:p.profileRevision,
      profileExists:store.profiles.some((profile)=>profile.id===p.profileId),
      createdAt:p.createdAt,
    }));
    res.json(summaries);
  });
  app.get('/api/previews/:id',(req,res)=>{
    const record=getPreview(store,req.params.id);
    if(!record)return res.status(404).json({error:'not_found'});
    res.json({...record, profileExists:store.profiles.some((p)=>p.id===record.profileId)});
  });

  return app;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'));
}
