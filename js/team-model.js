// UIと検証で共用する純粋な集計関数。UTC/JSTのズレを避け、日付文字列で比較する。
(function(root){
 const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const model={today,
  yearFor(date,month){return Number(date.slice(0,4))-(Number(date.slice(5,7))<Number(month)?1:0);},
  yearRange(year,month){const m=String(month).padStart(2,'0');return [year+'-'+m+'-01',(Number(year)+1)+'-'+m+'-01'];},
  count(data,event){
   const members=data.members.filter(m=>m.active&&m.squad===event.squad);
   const answers=data.answers.filter(a=>a.event_id===event.id&&members.some(m=>m.id===a.member_id));
   const guests=data.guests.filter(g=>g.event_id===event.id&&g.status==='yes');
   const yes=answers.filter(a=>a.status==='yes'); const no=answers.filter(a=>a.status==='no');
   const byRole=role=>yes.filter(a=>members.some(m=>m.id===a.member_id&&m.member_role===role)).length;
   return {yes:yes.length,no:no.length,unknown:members.length-yes.length-no.length,guests:guests.length,total:yes.length+guests.length,
    cars:event.asks_car?yes.filter(a=>a.car==='yes').length+guests.filter(g=>g.car).length:0,player:byRole('player'),staff:byRole('staff'),ac:byRole('ac'),memberGuest:byRole('guest')};
  },
  annual(data,member,year){const [start,end]=model.yearRange(year,data.year_start_month);return data.answers.filter(a=>a.member_id===member.id&&a.status==='yes'&&data.events.some(e=>e.id===a.event_id&&e.squad===member.squad&&e.event_date>=start&&e.event_date<end&&e.event_date<=today())).length;},
  ledger(data,squad){let balance=Number(data[squad+'_opening']);let projected=balance;let income=0,expense=0;
   const rows=data.ledger.filter(l=>l.squad===squad).slice().sort((a,b)=>a.entry_date.localeCompare(b.entry_date)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).map(l=>{
    const received=l.income===null?l.fee*l.people:l.income;const net=received-l.expense;projected+=net;
    if(!l.planned){balance+=net;income+=received;expense+=l.expense;}return {...l,received,net,balance};});
   return {rows,balance,projected,income,expense};
  }
 };
 if(typeof module!=='undefined'&&module.exports)module.exports=model;else root.TeamModel=model;
})(typeof window!=='undefined'?window:globalThis);
