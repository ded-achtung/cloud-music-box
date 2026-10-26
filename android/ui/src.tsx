import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme, CssBaseline, Box, Button, TextField, IconButton, Slider, Typography, ListItemButton } from '@mui/material'
import { PlayArrowRounded, PauseRounded, SkipNextRounded, SkipPreviousRounded } from '@mui/icons-material'
import { TrackCover } from '../../src/components/track-cover'
import { MarqueeText } from '../../src/components/marquee-text'
import './style.css'

type Track = { id:string; title:string; artists:string[]; artworkUrl:string|null }
type State = { connected:boolean; playing:boolean; playWhenReady:boolean; buffering:boolean; id:string; title:string; artist:string; index:number; count:number; positionMs:number; durationMs:number; error:string }
declare global { interface Window { NativeMusic: {postMessage(s:string):void; onmessage:((e:{data:string})=>void)|null} } }
let sequence=0
const pending=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void}>()
window.NativeMusic.onmessage = e=>{const msg=JSON.parse(e.data);const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.reject(new Error(msg.error)):p.resolve(msg.result)}
function call<T>(action:string, args:Record<string,unknown> = {}):Promise<T>{return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});window.NativeMusic.postMessage(JSON.stringify({id,action,...args}))})}
const art = new Map<string,Promise<string>>()
function artwork(path:string):Promise<string>{let p=art.get(path);if(!p){p=call<string>('artwork',{path});art.set(path,p);p.catch(()=>art.delete(path))}return p}
function TrackRow({track,onClick,active}:{track:Track;onClick:()=>void;active:boolean}) {
  const [cover,setCover]=useState<string>();const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(!track.artworkUrl||!ref.current)return;let alive=true;const ob=new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting){ob.disconnect();artwork(track.artworkUrl!).then(x=>{if(alive)setCover(x)}).catch(()=>{})}});ob.observe(ref.current);return()=>{alive=false;ob.disconnect()}},[track.artworkUrl])
  return <ListItemButton ref={ref} selected={active} onClick={onClick} sx={{gap:2,borderRadius:2}}><TrackCover coverUrl={cover}/><Box sx={{minWidth:0}}><Typography noWrap>{track.title}</Typography><Typography noWrap variant="body2" color="text.secondary">{track.artists?.join(', ')}</Typography></Box></ListItemButton>
}
const theme=createTheme({palette:{mode:'dark',primary:{main:'#b4c5ff'},background:{default:'#111319',paper:'#20232c'}}})
function App(){
 const [server,setServer]=useState('');const [debug,setDebug]=useState(false);const [tracks,setTracks]=useState<Track[]>([]);const [state,setState]=useState<State>();const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [drag,setDrag]=useState<number|null>(null)
 const execute=(action:string,args:Record<string,unknown>={})=>call<State>(action,args).then(setState).catch(e=>setError(e.message))
 const load=(url:string)=>{if(!url)return;setLoading(true);setError('');call<Track[]>('load',{server:url}).then(list=>{art.clear();setTracks(list)}).catch(e=>setError(e.message)).finally(()=>setLoading(false))}
 useEffect(()=>{call<{server:string;debug:boolean}>('config').then(c=>{setServer(c.server);setDebug(c.debug);if(c.server)load(c.server)}).catch(e=>setError(e.message));let cancelled=false;const poll=()=>call<State>('state').then(x=>{if(!cancelled)setState(x)}).catch(()=>{});poll();const timer=setInterval(poll,750);return()=>{cancelled=true;clearInterval(timer)}},[])
 const time=(n:number)=>`${Math.floor(n/60000)}:${String(Math.floor(n/1000)%60).padStart(2,'0')}`
 return <ThemeProvider theme={theme}><CssBaseline/><main><header><Typography variant="h5">Cloud Music Box</Typography><Typography color="text.secondary" variant="body2">Музыка с вашего сервера</Typography></header><Box className="server"><TextField fullWidth size="small" label="Адрес сервера" placeholder={debug?'http://192.168.1.10:3000':'https://music.example'} value={server} onChange={e=>setServer(e.target.value)}/><Button variant="contained" disabled={loading} onClick={()=>load(server)}>{loading?'Загрузка':'Подключить'}</Button></Box>{error&&<Typography color="error" role="alert">{error}</Typography>}<Typography variant="h6" sx={{mt:2,mb:1}}>Композиции · {tracks.length}</Typography><div className="tracks">{tracks.map((t,i)=><TrackRow key={t.id} track={t} active={state?.id===t.id} onClick={()=>execute('select',{index:i})}/>)}</div><section className="player"><MarqueeText text={state?.title||'Выберите композицию'} variant="subtitle1"/><Typography color="text.secondary" variant="body2">{state?.artist || (state?.buffering?'Загрузка…':'')}</Typography><Slider aria-label="Позиция" min={0} max={Math.max(state?.durationMs||0,1)} value={Math.min(drag??state?.positionMs??0,Math.max(state?.durationMs||0,1))} onChange={(_,v)=>setDrag(v as number)} onChangeCommitted={(_,v)=>{setDrag(null);execute('seek',{positionMs:v as number})}}/><div className="time"><span>{time(state?.positionMs||0)}</span><span>{time(state?.durationMs||0)}</span></div><div className="controls"><IconButton aria-label="Предыдущий" onClick={()=>execute('previous')}><SkipPreviousRounded/></IconButton><IconButton aria-label={state?.playWhenReady?'Пауза':'Воспроизвести'} onClick={()=>execute(state?.playWhenReady?'pause':'play')}>{state?.playWhenReady?<PauseRounded/>:<PlayArrowRounded/>}</IconButton><IconButton aria-label="Следующий" onClick={()=>execute('next')}><SkipNextRounded/></IconButton></div><Typography variant="caption" color="error">{state?.error}</Typography></section></main></ThemeProvider>
}
createRoot(document.getElementById('root')!).render(<App/>)
