// Bounded reads using UXP's documented fs.open/read/close API. No full-WAV
// copies: retain only RMS and peak per 20 ms analysis block.
const tag=(view,offset)=>String.fromCharCode(...new Uint8Array(view.buffer,offset,4));
async function exact(io,fd,position,length) {
  const buffer=new ArrayBuffer(length);let offset=0;
  while(offset<length) {
    const result=await io.read(fd,buffer,offset,length-offset,position+offset);
    if(!result.bytesRead) throw Error('Incomplete music analysis WAV');
    offset+=result.bytesRead;
  }
  return new DataView(buffer);
}
async function header(io,fd,size,expected) {
  const head=await exact(io,fd,0,12);
  if(tag(head,0)!=='RIFF'||tag(head,8)!=='WAVE'||head.getUint32(4,true)+8!==size) throw Error('Music WAV is incomplete or is not RIFF/WAVE');
  let format,dataOffset,dataBytes;
  for(let offset=12;offset+8<=size;) {
    const chunk=await exact(io,fd,offset,8),bytes=chunk.getUint32(4,true),body=offset+8;
    if(body+bytes>size) throw Error('Incomplete WAV chunk');
    if(tag(chunk,0)==='fmt ') {
      if(bytes<16) throw Error('Invalid WAV format');
      const v=await exact(io,fd,body,Math.min(bytes,40));
      let code=v.getUint16(0,true);
      if(code===65534) {
        if(bytes<40 || v.getUint16(16,true)<22) throw Error('Invalid extensible WAV');
        code=v.getUint16(24,true);
        const guid=[0,0,0,0,16,0,128,0,0,170,0,56,155,113];
        if(guid.some((x,i)=>v.getUint8(26+i)!==x)) throw Error('Unsupported WAV subformat');
      }
      format={code,channels:v.getUint16(2,true),rate:v.getUint32(4,true),align:v.getUint16(12,true),bits:v.getUint16(14,true)};
    }
    if(tag(chunk,0)==='data') {
      if(dataOffset!==undefined) throw Error('Multiple WAV data chunks are unsupported');
      dataOffset=body;dataBytes=bytes;
    }
    offset=body+bytes+bytes%2;
  }
  if(!format || !dataBytes || ![1,2].includes(format.channels) || format.align!==format.channels*format.bits/8 || dataBytes%format.align) throw Error('Invalid PCM music WAV');
  if(!(format.code===1 && [8,16,24,32].includes(format.bits) || format.code===3 && [32,64].includes(format.bits))) throw Error('Unsupported music WAV sample format');
  const samples=dataBytes/format.align;
  if(format.rate!==expected.rate || format.channels!==expected.channels || Math.abs(samples/format.rate-expected.duration)>1/format.rate) throw Error('Music export layout/duration does not match the timeline');
  return {...format,samples,dataOffset,dataBytes};
}
function sample(v,i,code,bits) {
  if(code===3) return bits===32?v.getFloat32(i,true):v.getFloat64(i,true);
  if(bits===8) return (v.getUint8(i)-128)/128;
  if(bits===16) return v.getInt16(i,true)/32768;
  if(bits===32) return v.getInt32(i,true)/2147483648;
  let n=v.getUint8(i)|(v.getUint8(i+1)<<8)|(v.getUint8(i+2)<<16);
  if(n&0x800000) n-=0x1000000;
  return n/8388608;
}
async function readSummary(file,expected,{io,check=()=>{},sleep,onWait=()=>{},onRead=()=>{},deadlineMs=15*60*1000,renderWaitMode,exportLabel='Analysis export'}) {
  io=io || require('fs');
  const pollMs=renderWaitMode==='events'?200:1000;
  const deadline=Date.now()+deadlineMs;let stable=0,lastSize=-1,format,fd;
  try {
    while(Date.now()<deadline) {
      check();
      try {
        const stat=await io.lstat(file.nativePath);
        if(fd!==undefined) {await io.close(fd);fd=undefined;}
        fd=await io.open(file.nativePath,'r');
        format=await header(io,fd,stat.size,expected);
        stable=stat.size===lastSize?stable+1:1;lastSize=stat.size;
        if(stable>=2) break;
      } catch(error) {stable=0;}
      onWait();await sleep(pollMs);
    }
    if(stable<2) throw Error(`${exportLabel} timed out after ${Math.round(deadlineMs/60000)} min while waiting for a complete ${Math.round(expected.duration)}s WAV at ${file.nativePath}. Premiere may still be rendering, or the export may be blocked by a dialog. Keep the timeline unchanged; delete any leftover WTV_*_ANALYSIS sequence if retrying.`);
    const size=Math.round(format.rate*.02),count=Math.ceil(format.samples/size);
    const levels=new Float64Array(count),peaks=new Float64Array(count);let peak=0;
    for(let block=0;block<count;block+=128) {
      check();
      const start=block*size,end=Math.min(format.samples,(block+128)*size);
      const v=await exact(io,fd,format.dataOffset+start*format.align,(end-start)*format.align);
      for(let b=block;b<Math.min(count,block+128);b++) {
        let sum=0,maximum=0;
        for(let frame=b*size;frame<Math.min(format.samples,(b+1)*size);frame++) for(let c=0;c<format.channels;c++) {
          const value=sample(v,(frame-start)*format.align+c*format.bits/8,format.code,format.bits);
          if(!Number.isFinite(value)) throw Error('Music analysis WAV contains non-finite samples');
          sum+=value*value;maximum=Math.max(maximum,Math.abs(value));
        }
        levels[b]=Math.sqrt(sum/(size*format.channels)); // same zero-padded final block as service
        peaks[b]=maximum;peak=Math.max(peak,maximum);
      }
      onRead(Math.min(1,(block+128)/count));await sleep(0);
    }
    check();
    const finalStat=await io.lstat(file.nativePath);
    if(finalStat.size!==lastSize) throw Error('Analysis WAV changed while reading');
    return {levels,peaks,peak,rate:format.rate,channels:format.channels,samples:format.samples,exportWait:renderWaitMode||'poll'};
  } finally {if(fd!==undefined) await io.close(fd);}
}
module.exports={readSummary,header,exact,sample};
