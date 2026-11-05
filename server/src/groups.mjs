import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
export const DEFAULT_GROUP = 'new-endpoints';
export function mountGroups(router, {db,audit,fail,str}) {
  const view = id => {
    const group = db.prepare('SELECT * FROM endpoint_groups WHERE id=?').get(id);
    if(!group) fail(404,'Group not found.');
    const members = db.prepare('SELECT last_seen FROM endpoints WHERE group_id=? AND revoked=0').all(id);
    return {id:group.id,name:group.name,description:group.description,createdAt:group.created_at,isDefault:id===DEFAULT_GROUP,autoUpdate:group.auto_update!==0,
      endpointCount:members.length,onlineCount:members.filter(row=>Date.now()-Date.parse(row.last_seen)<120000).length};
  };
  const input = body => {
    const name = str(body.name,'name',{max:100}).trim();
    if(!name) fail(400,'Enter a group name.');
    return {name,description:str(body.description,'description',{min:0,max:1000,fallback:''})};
  };
  const unique = (name,id='') => {if(db.prepare('SELECT id FROM endpoint_groups WHERE name=? COLLATE NOCASE AND id<>?').get(name,id)) fail(409,'A group with this name already exists.');};
  router.get('/groups',(req,res)=>res.json(db.prepare('SELECT id FROM endpoint_groups ORDER BY CASE id WHEN ? THEN 0 ELSE 1 END,name COLLATE NOCASE').all(DEFAULT_GROUP).map(row=>view(row.id))));
  router.post('/groups',(req,res)=>{
    const {name,description}=input(req.body);unique(name);const id=randomUUID();
    db.prepare('INSERT INTO endpoint_groups(id,name,description,created_at) VALUES (?,?,?,?)').run(id,name,description,new Date().toISOString());
    audit(req.operator.username,'group.created',id,{name});res.status(201).json(view(id));
  });
  router.patch('/groups/:id',(req,res)=>{
    const old=view(req.params.id);if(old.isDefault) fail(409,'The New endpoints group is permanent.');
    const {name,description}=input(req.body);unique(name,old.id);
    db.prepare('UPDATE endpoint_groups SET name=?,description=? WHERE id=?').run(name,description,old.id);
    audit(req.operator.username,'group.updated',old.id,{name});res.json(view(old.id));
  });
  // Allowed for every group, including the permanent New endpoints group. Manual
  // "Update agent" requests are unaffected; this only controls agents' own automatic checks.
  router.put('/groups/:id/auto-update',(req,res)=>{
    const group=view(req.params.id);
    if(typeof req.body?.autoUpdate!=='boolean') fail(400,'autoUpdate must be true or false.');
    db.prepare('UPDATE endpoint_groups SET auto_update=? WHERE id=?').run(req.body.autoUpdate?1:0,group.id);
    audit(req.operator.username,'group.auto_update.changed',group.id,{autoUpdate:req.body.autoUpdate});res.json(view(group.id));
  });
  router.post('/groups/:id/members',(req,res)=>{
    const result=transaction(db,()=>{
      const group=view(req.params.id);const values=req.body.endpointIds;
      if(!Array.isArray(values)||!values.length||values.length>10000||values.some(id=>typeof id!=='string'||id.length>100)) fail(400,'Select 1 to 10000 endpoints.');
      const ids=[...new Set(values)];
      for(const id of ids) if(!db.prepare('SELECT id FROM endpoints WHERE id=? AND revoked=0').get(id)) fail(400,'An endpoint is unavailable or revoked. No endpoints were moved.');
      for(const id of ids) db.prepare('UPDATE endpoints SET group_id=? WHERE id=?').run(group.id,id);
      audit(req.operator.username,'group.members.moved',group.id,{endpointIds:ids});return {moved:ids.length,group:view(group.id)};
    });res.json(result);
  });
  router.delete('/groups/:id',(req,res)=>{
    transaction(db,()=>{
      const group=view(req.params.id);if(group.isDefault) fail(409,'The New endpoints group cannot be deleted.');
      const destination=view(req.body?.moveToGroupId||DEFAULT_GROUP);
      if(destination.id===group.id) fail(400,'Choose a different destination group.');
      db.prepare('UPDATE endpoints SET group_id=? WHERE group_id=?').run(destination.id,group.id);
      db.prepare('DELETE FROM endpoint_groups WHERE id=?').run(group.id);
      audit(req.operator.username,'group.deleted',group.id,{moveToGroupId:destination.id});
    });res.json({ok:true});
  });
}
