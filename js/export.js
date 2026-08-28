// Reference workbook + event data -> real .xlsx. No network or runtime library.
(function(root){
 'use strict';
 const template=typeof module!=='undefined'?require('./export-template'):root.AttendanceTemplate;
 const xml=v=>String(v??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 function collect(data,event){
  const rows=[],warnings=[];
  function vehicle(a,name,isGuest){
   if(a.uses_bicycle)return '自転車利用';
   if(isGuest?a.car===true:a.car==='yes'){
    if(!a.vehicle_plate){warnings.push(name+'：ナンバー未入力');return 'ナンバー未入力';}
    return a.vehicle_plate;
   }
   if(!isGuest&&event.asks_car&&a.car!=='no'){warnings.push(name+'：車の利用予定が未回答');return '未回答';}
   return '';
  }
  for(const m of data.members){const a=data.answers.find(a=>a.event_id===event.id&&a.member_id===m.id&&a.status==='yes');if(a)rows.push({name:m.name,vehicle:vehicle(a,m.name,false)});}
  for(const g of data.guests.filter(g=>g.event_id===event.id&&g.status==='yes'))rows.push({name:g.name,vehicle:vehicle(g,g.name,true)});
  return {rows,warnings};
 }
 const enc=new TextEncoder();
 const crcTable=Array.from({length:256},(_,i)=>{for(let n=0;n<8;n++)i=(i&1)?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
 function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
 function zip(files){
  const chunks=[],directory=[];let offset=0,dirSize=0;
  for(const [path,body] of Object.entries(files)){
   const name=enc.encode(path),bytes=enc.encode(body),checksum=crc(bytes),header=new Uint8Array(30+name.length),h=new DataView(header.buffer);
   h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(12,33,true);h.setUint32(14,checksum,true);h.setUint32(18,bytes.length,true);h.setUint32(22,bytes.length,true);h.setUint16(26,name.length,true);header.set(name,30);
   const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
   c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(14,33,true);c.setUint32(16,checksum,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);
   chunks.push(header,bytes);directory.push(central);offset+=header.length+bytes.length;dirSize+=central.length;
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,directory.length,true);e.setUint16(10,directory.length,true);e.setUint32(12,dirSize,true);e.setUint32(16,offset,true);
  const out=new Uint8Array(offset+dirSize+22);let at=0;for(const b of [...chunks,...directory,end]){out.set(b,at);at+=b.length;}return out;
 }
 function create(data,event){
  const {rows,warnings}=collect(data,event),pages=Math.max(1,Math.ceil(rows.length/25)),files={...template};let content='';
  const cell=(ref,value,style)=>`<x:c r="${ref}" s="${style}" t="inlineStr"><x:is><x:t xml:space="preserve">${xml(value)}</x:t></x:is></x:c>`;
  for(let p=0;p<pages;p++){
   let r=p*26+1;content+=`<x:row r="${r}" ht="30" customHeight="1">`+['人数','参加者氏名（代表者を含む）','入場車両番号（自転車は自転車利用と記載）'].map((v,i)=>cell('ABC'[i]+r,v,7)).join('')+'</x:row>';
   for(let i=0;i<25;i++){r++;const n=p*25+i,entry=rows[n]||{};content+=`<x:row r="${r}" ht="22" customHeight="1"><x:c r="A${r}" s="4" t="n"><x:v>${n+1}</x:v></x:c>${cell('B'+r,entry.name,5)}${cell('C'+r,entry.vehicle,5)}</x:row>`;}
  }
  let sheet=files['xl/worksheets/sheet1.xml'].replace(/<x:sheetData>[\s\S]*?<\/x:sheetData>/,`<x:sheetData>${content}</x:sheetData>`);
  sheet=sheet.replace('<x:sheetViews>','<x:sheetPr><x:pageSetUpPr fitToPage="1"/></x:sheetPr><x:sheetViews>');
  sheet=sheet.replace(/<x:pageMargins[^>]*\/>/,'<x:printOptions horizontalCentered="1"/><x:pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>');
  const caption=(event.event_date+' '+(event.place||'')).slice(0,110).replaceAll('&','&&');
  sheet=sheet.replace('</x:worksheet>',`<x:pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/><x:headerFooter><x:oddHeader>${xml('&L'+caption)}</x:oddHeader><x:oddFooter>&amp;R&amp;P / &amp;N</x:oddFooter></x:headerFooter>${pages>1?`<x:rowBreaks count="${pages-1}" manualBreakCount="${pages-1}">${Array.from({length:pages-1},(_,i)=>`<x:brk id="${(i+1)*26}" max="16383" man="1"/>`).join('')}</x:rowBreaks>`:''}</x:worksheet>`);
  files['xl/worksheets/sheet1.xml']=sheet;
  files['xl/workbook.xml']=files['xl/workbook.xml'].replace('</x:workbook>',`<x:definedNames><x:definedName name="_xlnm.Print_Area" localSheetId="0">'参加者名簿'!$A$1:$C$${pages*26}</x:definedName></x:definedNames></x:workbook>`);
  const filename=('参加者名簿_'+event.event_date+'_'+(event.place||'会場未定')).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,130)+'.xlsx';
  return {bytes:zip(files),filename,count:rows.length,pages,warnings};
 }
 function download(result){const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const a=document.createElement('a');a.href=url;a.download=result.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 const api={collect,create,download};if(typeof module!=='undefined')module.exports=api;else root.AttendanceExport=api;
})(typeof window!=='undefined'?window:globalThis);
