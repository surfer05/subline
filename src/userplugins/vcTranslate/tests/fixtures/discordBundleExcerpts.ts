/**
 * Excerpts of Discord's public web client (discord.com/assets, fetched with
 * no login on 2026-09-25), one per surface patch replacement: the code each
 * match was written against. Regression fixtures for tests/surfacePatches.test.ts;
 * the full-bundle check (every find in exactly one module) was run by hand.
 */
export const BUNDLE_EXCERPTS: Array<{ patch: number; replacement: number; module: string; count: number; excerpt: string; }> = [
    {
        "patch": 0,
        "replacement": 0,
        "module": "465829",
        "count": 1,
        "excerpt": "x)(p.A,{userName:l,displayNameStyles:f,effectDisplayType:g.G.ANIMATED,textClassName:_.QC,shouldWrap:!0,loop:!0,inProfile:!0,shouldUnderlineOnHover:d,appendedInlineContent:null!=c?(0,a.jsxs)(a.Fragment,{children:[\" \",c]}):null})}):(0,a.jsxs)(i.E,{className:r()(_.QC,_.O2,u),variant:E,children:[l,\" \",c]})}function v(e){let{user:t,guildId:n,displayName:l,trailing:i,size:o=\"sm\",pendingDisplayNameStyles:d,onClickDisplayName:c}=e,m=(0,u.r)(t),g=null!=m?(0,a.jsx)(f.A,{type:m,verified:t.isVerifiedBot(),c"
    },
    {
        "patch": 1,
        "replacement": 0,
        "module": "46054",
        "count": 1,
        "excerpt": "EventRules(){return S()},get guildEventLocationRules(){return v()},get notifCenterV2MessagePreviewRules(){return _()},lockscreenWidgetMessageRules:j,astParserFor:s.X,reactParserFor:s.aV,parse:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return b()(...t)},parseTopic:(e,t,n,l)=>T()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseTruncatedTopic:(e,t,n,l)=>R()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseVoiceChannelStatus:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return O()(."
    },
    {
        "patch": 1,
        "replacement": 1,
        "module": "46054",
        "count": 1,
        "excerpt": "MessagePreviewRules(){return _()},lockscreenWidgetMessageRules:j,astParserFor:s.X,reactParserFor:s.aV,parse:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return b()(...t)},parseTopic:(e,t,n,l)=>T()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseTruncatedTopic:(e,t,n,l)=>R()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseVoiceChannelStatus:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return O()(...t)},parseEmbedTitle:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t"
    },
    {
        "patch": 1,
        "replacement": 2,
        "module": "46054",
        "count": 1,
        "excerpt": "arserFor:s.aV,parse:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return b()(...t)},parseTopic:(e,t,n,l)=>T()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseTruncatedTopic:(e,t,n,l)=>R()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseVoiceChannelStatus:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return O()(...t)},parseEmbedTitle:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return M()(...t)},parseEmbedTitleWithoutLinks:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n"
    },
    {
        "patch": 1,
        "replacement": 3,
        "module": "46054",
        "count": 1,
        "excerpt": "rguments[n];return M()(...t)},parseEmbedTitleWithoutLinks:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return L()(...t)},parseInlineReply:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return k()(...t)},parseGuildVerificationFormRule:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return w()(...t)},parseGuildEventDescription:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return P()(...t)},parseAutoModerationSystemMessage:function(){for(var e=arguments.length,t=Ar"
    },
    {
        "patch": 1,
        "replacement": 4,
        "module": "46054",
        "count": 1,
        "excerpt": "n];return w()(...t)},parseGuildEventDescription:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return P()(...t)},parseAutoModerationSystemMessage:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return D()(...t)},parseForumPostGuidelines:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return U()(...t)},parseToAST:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return V()(...t)},parseTopicToAST:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments"
    },
    {
        "patch": 2,
        "replacement": 0,
        "module": "435328",
        "count": 1,
        "excerpt": "t,{l:()=>d,y:()=>u});var i=n(46054),r=n(556300),a=n(881140);let l=i.A.guildEventRules,s={...l.link,react:(0,a.A)({enableBuildOverrides:!1,mustConfirmExternalLink:!0}).react},o={...l.channelMention,react:(0,r.A)({enableBuildOverrides:!1,shouldCloseDefaultModals:!0,shouldStopPropagation:!0}).react},d=i.A.reactParserFor({...l,link:s,channelMention:o}),u=i.A.reactParserFor({...i.A.guildEventLocationRules,link:s,channelMention:o})}"
    },
    {
        "patch": 3,
        "replacement": 0,
        "module": "542308",
        "count": 1,
        "excerpt": "(0,s.jsx)(l_.ChatIcon,{size:\"xs\",color:\"currentColor\",className:ep.gE})})})};renderChannelInfo(){let{channelInfo:e}=this.props;return null==e?null:(0,s.jsx)(\"div\",{className:ep.yW,children:e})}getTooltipText=()=>{let{connected:e}=this.props;return this.isFull()&&!e?em.intl.string(em.t.rZfiNq):null};renderSubtitle=()=>{let e=this.props.stageInstance?.topic;return null==e?null:(0,s.jsx)(tX.A,{children:e})};render(){let{channel:e,selected:t,connected:n,locked:l,connectChannelDropTarget:i,connectChannelDragSource:r,connectUserDropTarget:a,connectDragPreview:o,canReorderChannel:d,canMoveMembers:c,stageI"
    },
    {
        "patch": 3,
        "replacement": 1,
        "module": "542308",
        "count": 1,
        "excerpt": "]:!l&&p,[n$.V2]:!p&&!l&&g,[n$.lY]:o}),onMouseDown:E,onContextMenu:N,children:[!g||p||l?null:(0,s.jsx)(\"div\",{className:eK()(n$.gy,n$.WS)}),(0,s.jsx)(es.D,{...S,innerRef:b,className:n$.nf,onClick:C,onAuxClick:x,\"aria-label\":G,focusProps:{enabled:!1},children:(0,s.jsxs)(\"div\",{className:eK()(n$.Y5,n$.__invalid_threadMainContent),children:[(0,s.jsx)(e5.E,{variant:\"text-sm/medium\",color:\"none\",className:n$.UU,children:(0,s.jsx)(tX.A,{\"aria-hidden\":!0,children:A})}),(0,s.jsxs)(\"div\",{className:n$.Y_,onClick:nD.dG,onKeyDown:nD.dG,children:[(0,s.jsx)(lK,{thread:t,countInVoice:_,hasVideo:h,mentionCount:m,isMentionLowImportance:f}),(0,s.jsx)(ly,{thread:t,tabIndex"
    },
    {
        "patch": 4,
        "replacement": 0,
        "module": "350527",
        "count": 1,
        "excerpt": "u.rf,children:[(0,s.jsx)(ea.Ay,{channel:t}),(0,s.jsx)(\"div\",{className:i()(eu.wx,{[eu.qN]:m}),children:(0,s.jsxs)(\"div\",{className:eu.TK,children:[(0,s.jsx)(j.D,{variant:\"heading-lg/semibold\",color:d?\"text-strong\":\"text-muted\",lineClamp:2,className:eu.o$,children:(0,s.jsxs)(\"span\",{ref:h,children:[u,o&&(0,s.jsx)(\"span\",{className:eu.pr,children:(0,s.jsx)(v.Lp,{className:eu.Ad,color:g.A.unsafe_rawColors.BRAND_260.css,text:ed.intl.string(ed.t.y2b7CA)})})]})}),o&&m&&(0,s.jsx)(v.Lp,{className:eu.Ad,"
    },
    {
        "patch": 5,
        "replacement": 0,
        "module": "52933",
        "count": 1,
        "excerpt": ",height:16,color:\"white\"})})}),y?(0,s.jsx)(d.C,{variant:\"filter\",label:A.intl.string(A.t[\"P/y+sj\"]),items:S,size:\"xs\"}):x.map(e=>(0,s.jsx)(g.Ay,{tag:e,size:g.Ay.Sizes.SMALL,className:a()(l,{[j.At]:M.has(e.id)})},e.id)),N>0?(0,s.jsx)(g.q6,{tags:p,count:N,size:g.Ay.Sizes.SMALL,useManaTagGroup:y}):null]}):null}}"
    },
    {
        "patch": 6,
        "replacement": 0,
        "module": "442228",
        "count": 1,
        "excerpt": "function(e){null==j.current||j.current.contains(e.relatedTarget)||null==j.current.querySelector('[aria-expanded=\"true\"][aria-controls]')&&(j.current.scrollTop=0)},children:(0,l.jsx)(d.A,{userId:t,userBio:n,setLineClamp:!1,textColor:\"text-strong\",animateOnHoverOrFocusOnly:m,isHoveringOrFocusing:S})}),(R||v)&&(0,l.jsx)(\"div\",{className:A.HV,children:(0,l.jsx)(s.Q,{textVariant:\"text-xs/normal\",size:\"sm\",variant:\"secondary\",text:h.intl.string(h.t.YDiPq8),onClick:function(){a?.(),(0,c.openUserProfile"
    },
    {
        "patch": 7,
        "replacement": 0,
        "module": "123071",
        "count": 2,
        "excerpt": "NW,{currentQuestion:s+1,questionCount:r})}),a.required?(0,i.jsxs)(i.Fragment,{children:[(0,i.jsx)(k.E,{variant:\"text-xs/normal\",className:et.HE,children:\"\\xb7\"}),(0,i.jsx)(k.E,{variant:\"text-sm/medium\",color:\"text-brand\",children:q.intl.string(q.t.Ur8Vrt)})]}):null]}),(0,i.jsx)(c.D,{className:et.DD,variant:\"heading-xl/semibold\",color:\"text-strong\",id:t,children:a.title}),(0,i.jsx)(ee.A,{options:b,value:O,onChange:function(e){let t=e.find(e=>!h.includes(e.id)),n=e.map(e=>e.id);if(null!=t)u(a.id,t.id,!0);else{let e=h.filter(e=>!n.includes(e));a.options.filter(t=>e.includes(t.id)).forEach(e=>{u(a.id,e.id,!1)})}},memberCounts:E})]}),(0,i.jsxs)(\"div\",{className:et.N3,children:[(0,i.jsx)(\"div\",{className:et.X1,children:(s>0||o)&&(0,i.jsx)(P.$,{variant:\"secondary\",size:\"md\",text:q.intl.string(q.t[\"13/7kX\"]),onClick:()=>m(h.length),icon:W.Z,iconPosition:\"start\"})}),(0,i.jsxs)(\"div\",{className:et.Oh,children:[(0,i.jsxs)(k.E,{className:et.BK,variant:\"text-xs/normal\",color:\"text-muted\",children:[j,\" \",_]}),(0,i.jsx)(X.m,{asContainer:!0,text:p?q.intl.string(q.t.dA1dSf):null,children:(0,i.jsx)(P.$,{variant:f?\"secondary\":\"primary\",size:\"md\",text:l?`${q.intl.string(q.t[\"8SuVoE\"])} \\u{1F389}`:f?q.intl.string(q.t[\"5Wxrcd\"]):q.intl.string(q.t.PDTjLN),onClick:()=>l?g():x(h.length),disabled:p||d,loading:d,icon:l?void 0:G.K,iconPosition:\"end\"})})]})]})]})})}function es(e){let{headerId:t,guild:n,step:s,lastPrompt:l,questionCount:r,currentPrompt:a,hasConnections:o,isSubmitting:d,selectOption:u,gotoPrevPrompt:m,gotoNextPrompt:x,completeOnboarding:g}=e,h=(0,B.yK)([C.A],()=>C.A.getOnboardingResponsesForPrompt(n.id,a.id)),p=0===h.length&&a?.required,v=a?.options.filter(e=>h.includes(e.id)),A=(0,D.a)(v),N=(0,D.vV)(v),f=0===h.length,{helpText:j,helpTextAdditional:_}=(0,Q.A)({guild:n,prompt:a,selectedRoleIds:A,selectedChannelIds:N,itemHook:en});return(0,i.jsx)(\"div\",{className:et.J1,children:(0,i.jsxs)(\"div\",{className:et.mK,children:[(0,i.jsxs)(K.Ip,{className:et.gT,children:[(0,i.jsxs)(\"div\",{className:et.q,children:[(0,i.jsx)(k.E,{variant:\"text-sm/medium\",color:\"text-muted\",children:q.intl.format(q.t.isV0NW,{currentQuestion:s+1,questionCount:r})}),a.required?(0,i.jsxs)(i.Fragment,{children:[(0,i.jsx)(k.E,{variant:\"text-xs/normal\",className:et.HE,children:\"\\xb7\"}),(0,i.jsx)(k.E,{variant:\"text-sm/medium\",color:\"text-brand\",children:q.intl.string(q.t.Ur8Vrt)})]}):null]}),(0,i.jsx)(c.D,{className:et.DD,variant:\"heading-xl/semibold\",color:\"text-strong\",id:t,children:a.title}),(0,i.jsx)(\"div\",{className:et.vS,children:a.options.map(e=>(0,i.jsx)(Y.A,{guildId:n.id,option:e,onSelect:t=>u(a.id,e.id,t??!1),selected:h.includes(e.id)},e.id))})]}),(0,i.jsxs)(\"div\",{className:et.N3"
    }
];
