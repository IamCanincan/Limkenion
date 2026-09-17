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
// 识别看起来像自然语言的英文注释行（连续 ASCII 字母数超过阈值，且不是 URL / 键名）
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
    // 只处理纯注释行
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
