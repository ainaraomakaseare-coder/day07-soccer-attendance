/* チーム共有画面。秘密の鍵やメールを名簿へ表示しない。DBのRLS/RPCが最終的な権限を判定する。 */
(() => {
 'use strict';
 const app=document.getElementById('app'),dialog=document.getElementById('editor'),fields=document.getElementById('fields');
 const M=window.TeamModel;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const get=(k)=>{try{return localStorage.getItem('agape.'+k)||'';}catch{return '';}};
 const put=(k,v)=>{try{localStorage.setItem('agape.'+k,v);}catch{}};
 let data=null,key='',admin=false,squad='main',tab='events',eventId='',past=false,selected='',actor=get('actor')||'管理者',busy=false,edit=null;
 let year=M.yearFor(M.today(),4),timer;
 const roleName={player:'選手',staff:'スタッフ',ac:'AC',guest:'体験・ゲスト'};
 const actionName={answer:'出欠を更新',member:'名簿を更新',archive_member:'メンバーの利用状態を変更',event:'予定を保存',delete_event:'予定を削除',guest:'助っ人を更新',notice:'伝達事項を更新',ledger:'会計を保存',delete_ledger:'会計を削除',bib:'ビブスを更新',settings:'設定を更新',rotate_link:'共有リンクを変更',undo_answer:'出欠を取り消し'};
 const money=v=>Number(v).toLocaleString('ja-JP')+'円';
 const dateLabel=d=>new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',weekday:'short',timeZone:'Asia/Tokyo'}).format(new Date(d+'T12:00:00+09:00'));
 const btn=(label,act,attrs='',cls='secondary small')=>`<button type="button" class="${cls}" data-action="${act}" ${attrs}>${esc(label)}</button>`;
 const empty=text=>`<div class="empty">${esc(text)}</div>`;
 const memberName=id=>data.members.find(m=>m.id===id)?.name||'全員';
 const members=()=>data.members.filter(m=>m.squad===squad&&m.active);
 const attr=(key,value)=>`data-${key}="${esc(value)}"`;
 const answer=(ev,mid)=>data.answers.find(a=>a.event_id===ev&&a.member_id===mid);
 function toast(message,error=false){const el=document.getElementById('toast');el.textContent=message;el.className=error?'error':'';el.style.display='block';clearTimeout(timer);timer=setTimeout(()=>el.style.display='none',5500);}
 function gate(message=''){
  app.innerHTML=`<section class="panel gate"><span class="eyebrow">TEAM NOTE</span><h1>自分の出欠を、<br>すぐ回答。</h1><p>メインメンバーはGoogleでログインしてください。登録メールから自動で紐づくので、名前を選ぶ操作はありません。</p>${message?`<p class="inline-error">${esc(message)}</p>`:''}${Auth.loggedIn()?`<h2>新しく参加する</h2><p>管理者から聞いた4桁コードで登録できます。</p><form id="signup-form"><label class="field">名前<input name="name" required maxlength="80" autocomplete="name"></label><label class="field">参加コード（数字4桁）<input name="code" required inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off"></label><button>メンバー登録する</button></form>${btn('別のGoogleアカウントで入り直す','logout')}`:`${btn('Googleでログイン','signin','','')}<p class="hint">新しい方も、ログイン後に4桁の参加コードで登録できます。</p>`}</section>`;
 }

 function render(){
  if(!data)return;
  const sel=members().find(m=>m.id===selected);
  const nav=[['events','出欠'],['members','名簿'],['notices','伝達事項'],['annual','参加回数'],...(admin?[['ledger','会計']]:[]),['history','変更履歴'],...(admin?[['settings','設定']]:[])];
  app.innerHTML=`<section class="heading"><div><span class="eyebrow">${admin?'MANAGER DESK':'TEAM NOTE'}</span><h1>${esc(data.team)} <span class="tag">${admin?'管理者':data.me?'メイン':'ジュニア・共同編集'}</span></h1><div class="muted">出欠も、チームのことも。ここから。</div></div><div class="actor">${data.me?`<strong>${esc(data.me.name)}さん</strong>`:`<label for="actor">入力者（履歴用）</label><input id="actor" maxlength="80" placeholder="管理担当者名" value="${esc(actor)}">`}${!admin&&data.can_admin?btn('管理画面','manage'):''}${admin&&!key?btn('自分の出欠へ','my-page'):''}${btn('更新','refresh')}${btn('閉じる','logout')}</div></section>
  <nav class="nav" role="tablist" aria-label="管理項目">${nav.map(([k,l])=>`<button role="tab" aria-selected="${tab===k}" data-action="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
  ${tab==='events'?eventsView(sel):tab==='members'?membersView():tab==='notices'?noticesView():tab==='annual'?annualView():tab==='ledger'?ledgerView():tab==='bibs'?bibsView():tab==='settings'?settingsView():historyView()}`;
 }
 function eventsView(sel){
  if(eventId){const e=data.events.find(e=>e.id===eventId);if(e)return eventView(e);eventId='';}
  const list=data.events.filter(e=>e.squad===squad&&(past?e.event_date<M.today():e.event_date>=M.today())).sort((a,b)=>(a.event_date+(a.start_time||'')).localeCompare(b.event_date+(b.start_time||'')));if(past)list.reverse();
  const months=[...new Set(list.map(e=>e.event_date.slice(0,7)))];
  return '<div class="section-head"><div><h2>イベント一覧</h2><p class="hint">日程を選ぶと、その日の参加状況と出欠登録を開きます。</p></div>'+ (admin?btn('＋ 予定を作る','event-new','',''):'')+'</div><div class="toolbar">'+btn(past?'これからの予定':'過去の予定','past')+(admin?btn('＋ メンバー追加','member-new'):'')+'</div>'+months.map(month=>'<section class="panel schedule-month"><h3>'+esc(month.replace('-','年'))+'月</h3><div class="table-wrap"><table><thead><tr><th>日程</th><th>時間</th><th>場所</th><th>自分の出欠</th><th>出席</th></tr></thead><tbody>'+list.filter(e=>e.event_date.startsWith(month)).map(e=>{const a=sel?answer(e.id,sel.id):null,c=M.count(data,e);return '<tr><td>'+btn(dateLabel(e.event_date),'open-event',attr('id',e.id),'secondary schedule-date')+'</td><td>'+esc(e.start_time?.slice(0,5)||'時間未定')+(e.end_time?' – '+esc(e.end_time.slice(0,5)):'')+'</td><td>'+esc(e.place||'場所未定')+'<div class="hint">'+(e.kind==='match'?'試合':'練習')+'</div></td><td>'+(a?.status==='yes'?'○ 出席':a?.status==='no'?'× 欠席':'未回答')+'</td><td>'+c.total+'人</td></tr>';}).join('')+'</tbody></table></div></section>').join('')+(list.length?'':empty('予定がまだありません。'));
 }
 function juniorRows(e){return `<section class="panel junior-roster"><h3>${esc(dateLabel(e.event_date))} の出欠一覧</h3>${members().map(m=>{const a=answer(e.id,m.id);const attrs=attr('ev',e.id)+' '+attr('mid',m.id);return `<div class="junior-row"><div><strong>${esc(m.name)}</strong><div class="hint">${esc(roleName[m.member_role])} ${esc(m.grade)} · ${a?.status==='yes'?'出席':a?.status==='no'?'欠席':'未回答'}</div></div><div class="actions">${btn('○ 出席','quick',attrs+' data-status="yes"',a?.status==='yes'?'small chosen':'secondary small')}${btn('× 欠席','quick',attrs+' data-status="no"',a?.status==='no'?'small chosen':'secondary small')}${btn('詳細','answer',attrs)}</div></div>`}).join('')||empty('名簿にメンバーを追加してください。')}<p class="hint">各行のボタンで保存します。詳細から未回答に戻す・伝達事項を入力できます。</p></section>`;}
 function syncPlate(){const f=document.getElementById('edit-form'),plate=f.elements.vehicle_plate;if(!plate)return;const car=f.elements.car;const needs=f.elements.status?.value==='yes'&&(car?.type==='checkbox'?car.checked:car?.value==='yes');plate.required=needs&&!edit?.hasPlate;plate.disabled=!needs;plate.closest('label').hidden=!needs;}
 function eventView(e){const own=data.me?answer(e.id,data.me.id):null,c=M.count(data,e);const gs=data.guests.filter(g=>g.event_id===e.id);return `<div class="section-head"><div><h2>${esc(dateLabel(e.event_date))} ${esc(e.place)}</h2><div class="muted">メンバー ${members().length}人 · 助っ人 ${gs.filter(g=>g.status==='yes').length}人出席</div></div><div class="actions">${admin?btn('Excelを出力','export-event',attr('id',e.id),''):''}${btn('イベント一覧へ戻る','event-back')}</div></div>
  <section class="panel"><p><strong>時間：</strong>${esc(e.start_time?.slice(0,5)||'時間未定')}${e.end_time?' – '+esc(e.end_time.slice(0,5)):''}</p><p>${e.deadline?'回答期限：'+esc(dateLabel(e.deadline)):''} ${e.booking_person?'予約担当：'+esc(e.booking_person):''}</p><p class="note">${esc(e.note)}</p><div class="metrics"><div><b>${c.total}</b>出席（助っ人${c.guests}）</div><div><b>${c.no}</b>欠席</div><div><b>${c.unknown}</b>未回答</div><div><b>${e.asks_car?c.cars:'—'}</b>車</div></div>${data.me?'<p>自分の出欠：<strong>'+(own?.status==='yes'?'○ 出席':own?.status==='no'?'× 欠席':'未回答')+'</strong></p>'+btn('自分の出欠を登録・変更','answer',attr('ev',e.id)+' '+attr('mid',data.me.id),''):''}${admin?'<p class="hint">各参加者の「回答・修正」から代理で出欠を変更できます。</p><div class="actions">'+btn('予定を編集','event-edit',attr('id',e.id))+btn('予定を複製','event-copy',attr('id',e.id))+'</div>':''}</section>
  <div class="table-wrap"><table><thead><tr><th>名前</th><th>区分</th><th>出欠</th><th>車</th><th>伝達・確認</th><th>操作</th></tr></thead><tbody>${members().map(m=>{const a=answer(e.id,m.id);return `<tr><td>${esc(m.name)}</td><td>${roleName[m.member_role]}</td><td class="${a?.status||'unknown'}">${a?.status==='yes'?'○ 出席':a?.status==='no'?'× 欠席':'未回答'}</td><td>${a?.uses_bicycle?'自転車':a?.car==='yes'?'利用する':a?.car==='no'?'利用しない':'—'}${admin&&a?.vehicle_plate?`<div class="hint">${esc(a.vehicle_plate)}</div>`:''}</td><td class="note">${esc(a?.note)}${a?.confirmed?' ✓確認済み':''}</td><td>${admin||squad==='junior'||data.me?.id===m.id?btn('回答・修正','answer',`${attr('ev',e.id)} ${attr('mid',m.id)}`):'—'}</td></tr>`;}).join('')}</tbody></table></div>
  <div class="section-head"><h3>この日の助っ人</h3>${btn('＋ ゲストを追加','guest-new',attr('ev',e.id),'')}</div>${gs.length?`<div class="table-wrap"><table><thead><tr><th>名前</th><th>声掛け担当</th><th>出欠</th><th>車</th><th>伝達事項</th><th></th></tr></thead><tbody>${gs.map(g=>`<tr><td>${esc(g.name)}</td><td>${esc(g.invited_by)}</td><td>${g.status==='yes'?'○ 出席':'× 欠席'}</td><td>${g.uses_bicycle?'自転車':g.car?'利用する':'利用しない'}${admin&&g.vehicle_plate?`<div class="hint">${esc(g.vehicle_plate)}</div>`:''}</td><td class="note">${esc(g.note)}</td><td>${admin||squad==='junior'||g.created_by===data.me?.id?btn('修正','guest-edit',attr('id',g.id)):'—'}</td></tr>`).join('')}</tbody></table></div>`:empty('助っ人はまだ登録されていません。')}${admin?`<p>${btn('この予定を削除','delete-event',attr('id',e.id),'danger small')}</p>`:''}`;}
 function membersView(){return `<div class="section-head"><div><h2>メンバー名簿</h2><div class="hint">${squad==='junior'?'名前と区分だけで追加できます。':'Googleの登録メールと自動で紐づきます。名簿の追加・編集は管理者が行います。'}</div></div>${admin||squad==='junior'?btn('＋ 追加','member-new','',''):''}</div><div class="table-wrap"><table><thead><tr><th>番号</th><th>名前</th><th>区分</th><th>学年</th><th>所属・Jr.情報</th><th>代理入力者</th><th>背番号</th><th></th></tr></thead><tbody>${data.members.filter(m=>m.squad===squad&&(m.active||admin)).map(m=>`<tr><td>${esc(m.number)}</td><td>${esc(m.name)}${m.active?'':'（休会）'}</td><td>${roleName[m.member_role]}</td><td>${esc(m.grade)}</td><td class="note">${esc(m.affiliation)}</td><td>${esc(m.proxy_name)}</td><td>${esc(m.jersey)}</td><td>${m.active&&(admin||squad==='junior')?btn('編集','member-edit',attr('id',m.id)):''}${admin?btn(m.active?'休会にする':'再開','archive',`${attr('id',m.id)} data-active="${!m.active}"`,m.active?'danger small':'secondary small'):''}</td></tr>`).join('')}</tbody></table></div>${members().length?'':empty('最初のメンバーを追加しましょう。')}`;}
 function noticesView(){const notices=data.notices.filter(n=>n.squad===squad);return `<div class="section-head"><div><h2>伝達事項</h2><p class="hint">遅刻や連絡を日付付きで残せます。終わった連絡は「完了」に。</p></div>${btn('＋ 連絡を書く','notice-new','','')}</div><div class="stack">${notices.map(n=>`<article class="panel notice ${n.resolved?'done':''}"><div class="muted">${esc(n.notice_date)} · ${esc(memberName(n.member_id))} ${n.resolved?' · 完了':''}</div><p>${esc(n.body)}</p><div class="actions">${admin||squad==='junior'||n.member_id===data.me?.id?btn('編集・確認','notice-edit',attr('id',n.id)):''}<span class="hint">${n.confirmed_by?esc(n.confirmed_by)+' 確認済み':'未確認'}</span></div></article>`).join('')}</div>${notices.length?'':empty('伝達事項はありません。')}`;}
 function annualView(){const [start,end]=M.yearRange(year,data.year_start_month);return `<div class="section-head"><h2>年度別の参加回数</h2><div class="toolbar"><label for="year">年度</label><input class="timeline-year" id="year" type="number" min="2000" max="2100" value="${year}"></div></div><p class="hint">${start} 〜 ${Number(end.slice(0,4))}年${data.year_start_month}月1日の前日。今日までの「出席」回答を集計（未来の予定は除く）。過去の記録を登録すると反映されます。起算月は管理者が変更できます。</p><div class="table-wrap"><table><thead><tr><th>名前</th><th>区分</th><th class="num">参加回数</th></tr></thead><tbody>${data.members.filter(m=>m.squad===squad).map(m=>`<tr><td>${esc(m.name)}${m.active?'':'（休会）'}</td><td>${roleName[m.member_role]}</td><td class="num">${M.annual(data,m,year)}回</td></tr>`).join('')}</tbody></table></div>`;}
 function ledgerView(){if(!admin)return empty('会計は管理者のみ閲覧できます。');const l=M.ledger(data,squad);return `<div class="section-head"><div><h2>${squad==='main'?'メイン':'ジュニア'}会計</h2><div class="hint">参加予定人数と実際の徴収人数は別に管理します。${admin?'記入・修正できます。':'閲覧のみ。編集は管理者が行います。'}</div></div>${admin?btn('＋ 会計を記録','ledger-new','',''):''}</div><div class="ledger-summary"><div class="panel"><span class="muted">現在の残高</span><b>${money(l.balance)}</b></div><div class="panel"><span class="muted">予定を含む見込み</span><b>${money(l.projected)}</b></div><div class="panel"><span class="muted">収入 / 支出（実績）</span><b style="font-size:18px">${money(l.income)} / ${money(l.expense)}</b></div></div>
  <p class="hint">開始残高 ${money(data[squad+'_opening'])}。収入は参加費×人数（実収入を指定した場合はその額）。未確定の予定は現在の残高に含めません。</p><div class="table-wrap"><table><thead><tr><th>日付</th><th>内容</th><th>区分</th><th class="num">支出</th><th class="num">参加費</th><th class="num">人数</th><th class="num">収入</th><th class="num">差引</th><th class="num">実績残高</th><th>備考</th>${admin?'<th></th>':''}</tr></thead><tbody>${l.rows.slice().reverse().map(r=>`<tr><td>${r.entry_date}</td><td>${esc(r.description)}</td><td>${r.planned?'予定':'実績'}</td><td class="num">${money(r.expense)}</td><td class="num">${money(r.fee)}</td><td class="num">${r.people}</td><td class="num">${money(r.received)}</td><td class="num">${money(r.net)}</td><td class="num">${money(r.balance)}</td><td class="note">${esc(r.note)}</td>${admin?`<td>${btn('編集','ledger-edit',attr('id',r.id))}${btn('削除','delete-ledger',attr('id',r.id),'danger small')}</td>`:''}</tr>`).join('')}</tbody></table></div>${l.rows.length?'':empty('会計記録はまだありません。')}`;}
 function bibsView(){return `<div class="section-head"><h2>ジュニアビブス貸出表</h2>${btn('＋ ビブス追加','bib-new','','')}</div><p class="panel flow">${esc(data.bib_guide)}</p><div class="table-wrap"><table><thead><tr><th>番号</th><th>貸出先</th><th>状態</th><th>貸出日</th><th>返却日</th><th>備考</th><th></th></tr></thead><tbody>${data.bibs.map(b=>`<tr><td>${esc(b.number)}</td><td>${b.member_id?esc(memberName(b.member_id)):'—'}</td><td>${({available:'未貸出',loaned:'貸出中',return_due:'回収予定',returned:'返却済み'})[b.state]}</td><td>${b.loan_date||'—'}</td><td>${b.return_date||'—'}</td><td class="note">${esc(b.note)}</td><td>${btn('編集','bib-edit',attr('id',b.id))}</td></tr>`).join('')}</tbody></table></div>`;}
 function historyView(){return `<div class="section-head"><h2>みんなの変更履歴</h2></div><p class="hint">直近200件を表示。メインの入力者名はログイン情報、ジュニア・管理者は入力した名前です。出欠は、その後に同じ回答が変更されていなければ取り消せます。</p><div class="panel">${data.history.filter(h=>!h.squad||h.squad==='main').map(h=>{const v=h.after_value||h.before_value||{};return `<div class="history"><div><b>${esc(h.actor)}</b> · ${actionName[h.action]||esc(h.action)}<div class="hint">${h.entity.startsWith('answer:')?esc(memberName(h.entity.split(':')[2]))+' · '+esc(v.status==='yes'?'出席':v.status==='no'?'欠席':'未回答'):esc(v.name||v.description||v.number||'')}</div><small>${esc(new Date(h.created_at).toLocaleString('ja-JP'))}</small></div>${h.action==='answer'&&(admin||squad==='junior'||h.entity.split(':')[2]===data.me?.id)&&!data.history.some(x=>x.id>h.id&&x.entity===h.entity)?btn('取り消す','undo',`data-history="${h.id}"`):''}</div>`;}).join('')||empty('まだ変更履歴はありません。')}</div>`;}
 function settingsView(){return `<div class="settings"><h2>チーム設定</h2><div class="panel"><p>年度起算月：${data.year_start_month}月</p><p>参加費の初期値：${money(data.main_fee)}</p><p class="hint">年度起算月・開始残高を変更すると集計が変わります。</p>${btn('設定を変更','settings-edit','','')}</div><h3>参加コード</h3><div class="panel"><p>新しいメンバーへ伝える4桁コード：<strong>${esc(data.registration_code)}</strong></p><p class="hint">Googleログイン後にこのコードと名前で登録できます。チーム外へ公開しないでください。</p>${btn('参加コードを変更','registration-code')}</div><h3>メンバーに案内する</h3><div class="panel"><p>このURLをメンバーに共有してください。登録したGoogleメールでログインすると、自分の出欠が表示されます。</p><a href="./team.html">メンバー画面を開く</a>${btn('メンバー用URLをコピー','copy-main-link')}</div></div>`;}
 const field=(name,label,value='',type='text',options={})=>`<label class="field ${options.wide?'wide':''}">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${options.required?'required':''} ${options.min!==undefined?'min="'+options.min+'"':''} ${options.max!==undefined?'max="'+options.max+'"':''} ${options.maxlength?'maxlength="'+options.maxlength+'"':''}></label>`;
 const area=(name,label,value='')=>`<label class="field wide">${esc(label)}<textarea name="${name}" maxlength="2000">${esc(value)}</textarea></label>`;
 const check=(name,label,value)=>`<label class="field check"><input type="checkbox" name="${name}" ${value?'checked':''}>${esc(label)}</label>`;
 const select=(name,label,value,options)=>`<label class="field">${esc(label)}<select name="${name}">${options.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
 function openForm(type,v={},extra={}){
  edit={type,id:v.id||null,...extra};let html='';let title='';
  if(type==='member'){title=v.id?'メンバーを編集':'メンバー・体験ゲストを追加';html=(admin&&squad==='main'?field('email','Googleログイン用メール',v.email,'email'): '')+field('name','名前',v.name,'text',{required:true,maxlength:80})+select('member_role','区分',v.member_role||'player',Object.entries(roleName))+field('number','名簿番号',v.number,'text',{maxlength:20})+field('grade','学年',v.grade)+field('affiliation','所属・Jr.サッカー情報',v.affiliation)+field('proxy_name','代理入力者',v.proxy_name)+field('jersey','ユニフォーム背番号',v.jersey,'text',{maxlength:20});}
  if(type==='event'){title=extra.copy?'予定を複製':v.id?'予定を編集':'予定を作る';if(extra.copy)edit.id=null;html=(extra.copy?'<p class="wide template-note">日程・締切を入れ直してください。出欠と助っ人は複製しません。</p>':'')+field('event_date','日程',extra.copy?'':v.event_date||M.today(),'date',{required:true})+select('kind','種類',v.kind||'practice',[['practice','練習'],['match','試合']])+field('start_time','開始時刻',v.start_time?.slice(0,5),'time')+field('end_time','終了時刻',v.end_time?.slice(0,5),'time')+field('place','場所',v.place)+field('deadline','回答期限',extra.copy?'':v.deadline,'date')+field('booking_person','予約担当',v.booking_person)+check('cleaning','掃除の日',v.cleaning)+check('asks_car','車の回答を集める',v.asks_car??squad==='main')+area('note','注意事項',v.note);}
  if(type==='answer'){title=memberName(extra.mid)+'さんの回答';const e=data.events.find(e=>e.id===extra.ev);html=select('status','出欠',v.status||'',[['','未回答'],['yes','○ 出席'],['no','× 欠席']])+(e.asks_car?select('car','車の利用予定は？',v.uses_bicycle?'bicycle':v.car||'',[['','未回答'],['yes','利用する'],['no','利用しない'],['bicycle','自転車']])+field('vehicle_plate','ナンバー全体（例：横浜 300 あ 1234）',v.vehicle_plate||((extra.mid===data.me?.id?data.me:data.members.find(m=>m.id===extra.mid))?.vehicle_plate)||'','text',{maxlength:40,wide:true}):'')+area('note','遅刻など、この日の伝達事項',v.note)+check('confirmed','伝達を確認した',v.confirmed)+'<p class="hint wide">「未回答」は回答とこの日の伝達を取り消します。一般の連絡は伝達事項タブに残せます。</p>';}
  if(type==='guest'){title=v.id?'助っ人を修正':'この日の助っ人を追加';html=field('name','助っ人の名前',v.name,'text',{required:true,maxlength:80})+(data.me?`<p>声掛け担当：${esc(data.me.name)}</p>`:field('invited_by','声掛け担当',v.invited_by||actor))+select('status','出欠',v.status||'yes',[['yes','○ 出席'],['no','× 欠席']])+(data.events.find(e=>e.id===(extra.ev||v.event_id))?.asks_car?check('car','車の利用予定は？ 利用する',v.car)+check('uses_bicycle','自転車を利用する',v.uses_bicycle)+field('vehicle_plate','ナンバー全体（例：横浜 300 あ 1234）',v.vehicle_plate,'text',{maxlength:40,wide:true}):'')+area('note','伝達事項',v.note);edit.ev=extra.ev||v.event_id;}
  if(type==='notice'){title='伝達事項';html=field('notice_date','日付',v.notice_date||M.today(),'date',{required:true})+select('member_id','対象',data.me?.id||v.member_id||'',data.me?[[data.me.id,data.me.name]]:[['','全員'],...members().map(m=>[m.id,m.name])])+area('body','連絡内容',v.body)+check('confirmed','確認済み',!!v.confirmed_by)+check('resolved','対応完了',v.resolved);}
  if(type==='ledger'){title=v.id?'会計を修正':'会計を記録';html=field('entry_date','日付',v.entry_date||M.today(),'date',{required:true})+field('description','用途・内容',v.description,'text',{required:true,maxlength:200})+field('expense','支出（円）',v.expense??0,'number',{required:true,min:0,max:100000000})+field('fee','参加費（円 / 人）',v.fee??data[squad+'_fee'],'number',{required:true,min:0,max:1000000})+field('people','実際に徴収した人数',v.people??0,'number',{required:true,min:0,max:10000})+field('income','実収入（空欄なら参加費×人数）',v.income,'number',{min:0,max:100000000})+check('planned','まだ予定・未確定の記録',v.planned)+area('note','備考',v.note);}
  if(type==='bib'){title='ビブスの貸出・返却';html=field('number','ビブス番号',v.number,'text',{required:true,maxlength:20})+select('member_id','貸出先',v.member_id||'',[['','未指定'],...data.members.filter(m=>m.squad==='junior'&&m.active).map(m=>[m.id,m.name])])+select('state','状態',v.state||'available',[['available','未貸出'],['loaned','貸出中'],['return_due','回収予定'],['returned','返却済み']])+field('loan_date','貸出日',v.loan_date,'date')+field('return_date','返却日',v.return_date,'date')+area('note','備考',v.note);}
  if(type==='registration-code'){title='参加コードを変更';html=field('code','数字4桁の参加コード',data.registration_code,'text',{required:true,maxlength:4});}
  if(type==='settings'){title='設定を変更';html=field('year_start_month','年度の起算月',data.year_start_month,'number',{required:true,min:1,max:12})+field('main_fee','メイン参加費の初期値',data.main_fee,'number',{required:true,min:0,max:1000000})+field('main_opening','メイン開始残高',data.main_opening,'number',{required:true});}
  if(type==='answer'||type==='guest'){edit.hasPlate=!!(v.has_vehicle_plate||v.vehicle_plate||(type==='answer'&&(extra.mid===data.me?.id?data.me:data.members.find(m=>m.id===extra.mid))?.has_vehicle_plate));if(!admin)html+='<p class="hint wide">保存済みのナンバーは管理者のみ閲覧できます。'+(edit.hasPlate?'番号欄を空欄にすると登録済みの番号を使用します。変更する場合だけ入力してください。':'車を利用する場合はナンバー全体を入力してください。')+'</p>';}
  if(type==='answer'){const ev=data.events.find(e=>e.id===extra.ev);html=`<p class="wide">${esc(dateLabel(ev.event_date))} ${esc(ev.place)}<br><strong>まだ保存されていません。「確定する」で反映します。</strong></p>`+html;}
  document.querySelector('#edit-form button[type="submit"]').textContent=type==='answer'?'確定する':'保存する';
  fields.innerHTML=`<h2>${esc(title)}</h2>${html}${data.me?'':field('input_actor','入力する人（履歴用）',actor,'text',{required:true,maxlength:80,wide:true})}`;document.getElementById('form-error').textContent='';dialog.showModal();syncPlate();
 }
 async function load(){data=await DB.rpc('team_home',{p_key:key,p_admin:admin},!key);squad='main';selected=data.me?.id||'';if(data.me)actor=data.me.name;render();}
 async function write(action,payload){
  if(busy)return false;
  if(!actor.trim()){toast('画面上部の「入力する人」に名前を入れてください',true);dialog.close();document.getElementById('actor')?.focus();return false;}
  busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{data=await DB.rpc('team_write',{p_key:key,p_admin:admin,p_version:data.version,p_actor:actor,p_action:action,p_data:payload},!key);selected=data.me?.id||'';dialog.close();render();toast('保存しました');return true;}
  catch(e){const message=e.message||'保存できませんでした';toast(message,true);document.getElementById('form-error').textContent=message;if(message.includes('他の人の変更')){dialog.close();try{await load();}catch(refreshError){toast(refreshError.message,true);}}return false;}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 document.addEventListener('change',e=>{
  if(e.target.id==='actor'){actor=e.target.value.trim();put('actor',actor);}
  if(e.target.closest('#edit-form')){if(edit.type==='guest'&&e.target.checked&&['car','uses_bicycle'].includes(e.target.name)){const other=document.querySelector(`#edit-form [name="${e.target.name==='car'?'uses_bicycle':'car'}"]`);if(other)other.checked=false;}syncPlate();}
  if(e.target.id==='year'){const y=Number(e.target.value);if(y>=2000&&y<=2100){year=y;render();}}
 });
 document.addEventListener('submit',async e=>{
  if(e.target.id==='signup-form'){e.preventDefault();if(busy)return;busy=true;const f=new FormData(e.target);const submit=e.target.querySelector('button');submit.disabled=true;
   try{const r=await DB.rpc('join_main',{p_code:String(f.get('code')),p_name:String(f.get('name'))},true);if(!r.ok)throw new Error(r.error);await load();toast('メンバー登録しました');}catch(err){toast(err.message,true);}finally{busy=false;submit.disabled=false;}return;}

  if(e.target.id==='gate-form'){e.preventDefault();const val=new FormData(e.target).get('link').trim();try{const u=new URL(val,location.origin);if(u.origin!==location.origin)throw new Error();const hash=new URLSearchParams(u.hash.slice(1));const k=hash.get('team');if(!/^[a-f0-9]{32}$/.test(k||''))throw new Error();location.hash='team='+k;location.reload();}catch{toast('LINEに届いた、このアプリの共有リンクを貼り付けてください',true);}return;}
  if(e.target.id!=='edit-form')return;e.preventDefault();if(!edit)return;
  const p=Object.fromEntries(new FormData(e.target));for(const el of e.target.querySelectorAll('input[type=checkbox]'))p[el.name]=el.checked;
  actor=data.me?.name||String(p.input_actor||'').trim();put('actor',actor);delete p.input_actor;
  if(edit.type==='registration-code'){if(busy)return;busy=true;try{data=await DB.rpc('admin_registration_code',{p_admin:key,p_code:p.code},!key);dialog.close();render();toast('参加コードを変更しました');}catch(err){document.getElementById('form-error').textContent=err.message;}finally{busy=false;}return;}
  if(edit.id)p.id=edit.id;p.squad=squad;
  if(edit.type==='answer'){p.member_id=edit.mid;p.event_id=edit.ev;p.uses_bicycle=p.car==='bicycle';if(p.uses_bicycle)p.car='no';}
  if(edit.type==='guest')p.event_id=edit.ev;
  if(edit.type==='settings'){p.junior_fee=data.junior_fee;p.junior_opening=data.junior_opening;p.bib_guide=data.bib_guide;}
  await write(edit.type,p);
 });
 document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-action]');if(!b||busy)return;const a=b.dataset.action,id=b.dataset.id;
  try{
   if(a==='close'){dialog.close();return;}
   if(a==='refresh'){await load();toast('最新の状態に更新しました');return;}
   if(a==='manage'){location.hash='manage';return;}
   if(a==='my-page'){location.hash='';return;}
   if(a==='signin'){Auth.signIn(null);return;}
   if(a==='logout'){if(!key)await Auth.signOut();location.href='./team.html';return;}
   if(a==='copy-main-link'){await navigator.clipboard.writeText(location.origin+location.pathname);toast('メンバー用URLをコピーしました');return;}
   if(a==='tab'){if(b.dataset.tab==='ledger'&&!admin)return;tab=b.dataset.tab;eventId='';render();return;}
   if(a==='past'){past=!past;render();return;}
   if(a==='open-event'){eventId=id;render();return;}
   if(a==='event-back'){eventId='';render();return;}
   if(a==='quick'||a==='quick-car'){const mid=data.me?.id||b.dataset.mid||selected,old=answer(b.dataset.ev,mid)||{};
    openForm('answer',{...old,status:a==='quick'?b.dataset.status:'yes',uses_bicycle:a==='quick-car'?b.dataset.car==='bicycle':!!old.uses_bicycle,car:a==='quick-car'?(b.dataset.car==='bicycle'?'no':b.dataset.car):old.car||''},{ev:b.dataset.ev,mid});return;}
   if(a==='member-new')openForm('member');
   if(a==='member-edit')openForm('member',data.members.find(m=>m.id===id));
   if(a==='archive'&&confirm('このメンバーの利用状態を変更します。過去の出欠記録は残します。'))await write('archive_member',{id,active:b.dataset.active==='true'});
   if(a==='event-new')openForm('event');
   if(a==='event-edit'||a==='event-copy')openForm('event',data.events.find(x=>x.id===id),{copy:a==='event-copy'});
   if(a==='answer')openForm('answer',answer(b.dataset.ev,b.dataset.mid)||{},{ev:b.dataset.ev,mid:b.dataset.mid});
   if(a==='guest-new')openForm('guest',{}, {ev:b.dataset.ev});
   if(a==='guest-edit')openForm('guest',data.guests.find(x=>x.id===id));
   if(a==='notice-new')openForm('notice');
   if(a==='notice-edit')openForm('notice',data.notices.find(x=>x.id===id));
   if(a==='ledger-new')openForm('ledger');
   if(a==='ledger-edit')openForm('ledger',data.ledger.find(x=>x.id===id));
   if(a==='bib-new')openForm('bib');
   if(a==='bib-edit')openForm('bib',data.bibs.find(x=>x.id===id));
   if(a==='export-event'){if(!admin)return;await load();const ev=data.events.find(x=>x.id===id);if(!ev)throw new Error('予定が見つかりません');const file=AttendanceExport.create(data,ev);if(file.warnings.length&&!confirm('車の予定・ナンバーに未入力があります。未入力の旨を記載して出力しますか？\n'+file.warnings.join('\n')))return;AttendanceExport.download(file);toast(file.count+'名のExcelを出力しました');return;}
   if(a==='registration-code')openForm('registration-code');
   if(a==='settings-edit')openForm('settings');
   if(a==='delete-event'&&confirm('この予定と関連する出欠・助っ人を削除します。元に戻せません。')){await write('delete_event',{id});eventId='';render();}
   if(a==='delete-ledger'&&confirm('この会計記録を削除します。残高も再計算されます。'))await write('delete_ledger',{id});
   if(a==='undo'&&confirm('この出欠変更を取り消して、直前の回答に戻しますか？'))await write('undo_answer',{history_id:b.dataset.history});
   if(a==='copy-link'){const token=await DB.rpc('admin_shared_link',{p_admin:key});await navigator.clipboard.writeText(location.origin+location.pathname+'#team='+token);toast('共有リンクをコピーしました。チームLINEに貼り付けてください');}
   if(a==='rotate'&&confirm('古い共有リンクを無効にします。新しいリンクの配り直しが必要です。'))await write('rotate_link',{});
  }catch(err){toast(err.message||'操作できませんでした',true);}
 });
 async function start(){
  const authResult=Auth.absorbRedirect();
  if(authResult.error){gate(authResult.error);return;}
  const params=new URLSearchParams(location.hash.slice(1));
  if(params.has('team')){gate('ジュニアは今回の対象外です。メインはGoogleでログインしてください。');return;}
  admin=params.has('admin')||params.has('manage');key=params.get('admin')||'';
  if(key)document.querySelector('.brand').href=location.pathname+location.hash;
  if(!DB.ready()){gate('接続設定がありません。管理者が接続設定を確認してください。');return;}
  if((key&&!/^[a-f0-9]{32}$/.test(key))||(!key&&!Auth.loggedIn())){gate();return;}
  try{await load();year=M.yearFor(M.today(),data.year_start_month);}catch(e){gate(e.message);}
 }
 window.addEventListener('hashchange',()=>location.reload());
 start();
})();
