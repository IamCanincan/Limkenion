import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

function walk(dir){
  let out=[]
  for(const e of readdirSync(dir)){
    const p=join(dir,e)
    const s=statSync(p)
    if(s.isDirectory()) out=out.concat(walk(p))
    else if(/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

const files=walk('utils')
// Detect English comment lines that look like prose (words longer than a threshold of ascii letters, not URLs/keys)
const eng=/[A-Za-z]{5,}/
function hasEnglishComment(src){
  const lines=src.split('\n')
  let count=0
  for(const raw of lines){
    const line=raw.trim()
    const m=line.match(/\/\/|^\s*\*|^\/\*\*|\*\/|\/\*/)
    if(!/^\s*\/\/|\/\*\*|^\s*\*|\/\*\*?\*\//.test(line)) continue
    if(line.startsWith('// @')) continue
    if(line.startsWith('import')) continue
    // only pure-comment lines
    if(!line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/**')) continue
    const body=line.replace(/^\/\/\s*/,'').replace(/^\/\*+\s*/,'').replace(/^\*/,'').replace(/\*\//,'').trim()
    if(!body) continue
    if(/^[a-z_]{1,4}$/.test(body)) continue
    if(body.startsWith('@param')||body.startsWith('@returns')||body.startsWith('@example')||body.startsWith('@deprecated')||body.startsWith('@see')) continue
    if(/[\u4e00-\u9fa5]/.test(body)) continue
    if(/\b(https?:\/\/|\.js|\.ts|\.tsx|\.json|\[\w+\]|`|process\.env|--[a-z])/i.test(body)) continue
    const words=body.match(eng)
    if(words) count++
  }
  return count
}

const results=[]
for(const f of files){
  const src=readFileSync(f,'utf8')
  const c=hasEnglishComment(src)
  if(c>0) results.push({path:f.replaceAll('\\','/').replace('utils/',''), count:c, lines:src.split('\n').length})
}
results.sort((a,b)=>b.count-a.count)
console.log('Files with remaining English comments:', results.length)
for(const r of results){ console.log(`${r.count}\t${r.lines}\t${r.path}`) }
