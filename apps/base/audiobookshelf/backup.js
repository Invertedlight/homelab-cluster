const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const sqlite3 = require('/app/node_modules/sqlite3');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function files(root, dir = root) {
  return fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e => {
    const p = path.join(dir,e.name);
    if (e.isSymbolicLink()) throw Error('Unexpected symlink in backup');
    return e.isDirectory() ? files(root,p) : [{path:path.relative(root,p),sha256:hash(p)}];
  });
}
function open(p, mode) { return new Promise((resolve,reject)=>{ const db=new sqlite3.Database(p,mode,e=>e?reject(e):resolve(db)); }); }
const close = db => new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
async function integrity(p) {
  const db=await open(p,sqlite3.OPEN_READONLY);
  const rows=await new Promise((resolve,reject)=>db.all('PRAGMA integrity_check',(e,r)=>e?reject(e):resolve(r)));
  if(rows.length!==1 || rows[0].integrity_check!=='ok') throw Error('Database integrity failed');
  const counts={};
  for(const t of ['books','libraryItems','libraries','users','mediaProgresses']) {
    counts[t]=await new Promise((resolve,reject)=>db.get('SELECT COUNT(*) AS n FROM '+t,(e,r)=>e?reject(e):resolve(r.n)));
  }
  await close(db); return counts;
}
async function verify(root, manifest) {
  const actual=files(root);
  if(JSON.stringify(actual)!==JSON.stringify(manifest.files)) throw Error('Restored file checksums differ');
  const counts=await integrity(path.join(root,'config/absdatabase.sqlite'));
  if(JSON.stringify(counts)!==JSON.stringify(manifest.counts)) throw Error('Restored database counts differ');
  console.log(JSON.stringify({verifiedFiles:actual.length,database:'ok',counts}));
}
(async()=>{
  if(process.argv[2]==='verify') {
    await verify(process.argv[3],JSON.parse(fs.readFileSync(process.argv[4]))); return;
  }
  const root='/work/data'; fs.mkdirSync(root,{recursive:true});
  fs.cpSync('/source/config',root+'/config',{recursive:true,filter:p=>!/^absdatabase.*\.sqlite(?:-wal|-shm|-journal)?$/.test(path.basename(p))});
  fs.cpSync('/source/metadata',root+'/metadata',{recursive:true});
  const db=await open('/source/config/absdatabase.sqlite',sqlite3.OPEN_READONLY);
  const backup=db.backup(root+'/config/absdatabase.sqlite');
  backup.step(-1); backup.finish();
  for(let n=0; !backup.completed; n++) {
    if(backup.failed || n>=240) throw Error('SQLite online backup failed or timed out');
    await new Promise(r=>setTimeout(r,500));
  }
  await close(db);
  const manifest={createdAt:new Date().toISOString(),image:'2.36.0',counts:await integrity(root+'/config/absdatabase.sqlite'),files:files(root)};
  const base='/backup/scheduled-backups'; fs.mkdirSync(base,{recursive:true});
  const name='abs-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const staging=path.join(base,'.'+name+'-'+process.pid); fs.mkdirSync(staging);
  fs.writeFileSync(staging+'/manifest.json',JSON.stringify(manifest,null,2));
  execFileSync('tar',['-czf',staging+'/config-metadata.tar.gz','-C',root,'config','metadata']);
  const digest=hash(staging+'/config-metadata.tar.gz');
  fs.writeFileSync(staging+'/archive.sha256',digest+'  config-metadata.tar.gz\n');
  const restored='/work/verification'; fs.mkdirSync(restored);
  execFileSync('tar',['-xzf',staging+'/config-metadata.tar.gz','-C',restored]);
  await verify(restored,manifest);
  fs.writeFileSync(staging+'/SUCCESS','Verified archive and SQLite integrity\n');
  fs.renameSync(staging,path.join(base,name));
  const completed=fs.readdirSync(base).filter(n=>/^abs-\d{8}T\d{6}Z$/.test(n)&&fs.existsSync(path.join(base,n,'SUCCESS'))).sort();
  for(const old of completed.slice(0,-14)) fs.rmSync(path.join(base,old),{recursive:true});
  console.log('BACKUP_COMPLETE='+name);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
