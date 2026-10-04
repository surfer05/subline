/**
 * The smallest pieces of Discord's public web client (discord.com/assets,
 * fetched with no login on 2026-09-27; the status bubble sites on 2026-10-01) each surface patch match needs: for
 * each replacement, per site, just the matched text plus any context its
 * lookbehind or lookahead reads. Regression fixtures for
 * tests/surfacePatches.test.ts; the full-bundle check (every find in exactly
 * one module, every match at these sites and nowhere else) was run by hand.
 */
export const BUNDLE_SITES: Array<{ patch: number; replacement: number; module: string; sites: string[]; }> = [
    {
        "patch": 0,
        "replacement": 0,
        "module": "46054",
        "sites": [
            "parseTopic:(e,t,n,l)=>T()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseTruncatedTopic:"
        ]
    },
    {
        "patch": 0,
        "replacement": 1,
        "module": "46054",
        "sites": [
            "parseTruncatedTopic:(e,t,n,l)=>R()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseVoiceChannelStatus:"
        ]
    },
    {
        "patch": 0,
        "replacement": 2,
        "module": "46054",
        "sites": [
            "parseVoiceChannelStatus:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return O()(...t)}"
        ]
    },
    {
        "patch": 0,
        "replacement": 3,
        "module": "46054",
        "sites": [
            "parseGuildVerificationFormRule:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return w()(...t)}"
        ]
    },
    {
        "patch": 0,
        "replacement": 4,
        "module": "46054",
        "sites": [
            "parseForumPostGuidelines:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return U()(...t)}"
        ]
    },
    {
        "patch": 1,
        "replacement": 0,
        "module": "435328",
        "sites": [
            "d=i.A.reactParserFor({...l,link:s,channelMention:o})"
        ]
    },
    {
        "patch": 2,
        "replacement": 0,
        "module": "542308",
        "sites": [
            "renderSubtitle=()=>{let e=this.props.stageInstance?.topic;return null==e?null:(0,s.jsx)(tX.A,{children:e}"
        ]
    },
    {
        "patch": 2,
        "replacement": 1,
        "module": "542308",
        "sites": [
            "__invalid_threadMainContent),children:[(0,s.jsx)(e6.E,{variant:\"text-sm/medium\",color:\"none\",className:n$.UU,children:(0,s.jsx)(tX.A,{\"aria-hidden\":!0,children:A}"
        ]
    },
    {
        "patch": 3,
        "replacement": 0,
        "module": "350527",
        "sites": [
            "(\"span\",{ref:h,children:[u,o&&(0,s.jsx)(\"span\""
        ]
    },
    {
        "patch": 4,
        "replacement": 0,
        "module": "376310",
        "sites": [
            "lineClamp:1,color:\"currentColor\",children:v})]}),F={key:l.id"
        ]
    },
    {
        "patch": 5,
        "replacement": 0,
        "module": "394871",
        "sites": [
            "let C=g&&(null!=x?` ${m}`:m)"
        ]
    },
    {
        "patch": 6,
        "replacement": 0,
        "module": "442228",
        "sites": [
            "(0,l.jsx)(d.A,{userId:t,userBio:n,setLineClamp:!1,textColor:\"text-strong\",animateOnHoverOrFocusOnly:T,isHoveringOrFocusing:h})"
        ]
    },
    {
        "patch": 7,
        "replacement": 0,
        "module": "123071",
        "sites": [
            "(0,i.jsx)(c.D,{className:et.DD,variant:\"heading-xl/semibold\",color:\"text-strong\",id:t,children:a.title})",
            "(0,i.jsx)(c.D,{className:et.DD,variant:\"heading-xl/semibold\",color:\"text-strong\",id:t,children:a.title})"
        ]
    },
    {
        "patch": 8,
        "replacement": 0,
        "module": "394816",
        "sites": [
            "ea=null!=r?(0,l.jsx)(f.E,{variant:\"text-sm/normal\",className:ex.qS,children:r}):null,es=void 0!=="
        ]
    },
    {
        "patch": 8,
        "replacement": 1,
        "module": "394816",
        "sites": [
            "el({maxHeight:`${B?Math.min(w.current,b):n}px`})},[X,r,n,el,B,b,Z])"
        ]
    },
    {
        "patch": 8,
        "replacement": 2,
        "module": "394816",
        "sites": [
            "I=!C&&!n.bot&&!A;if(g){let e=null!=R&&\"\"!==R?R:null;return(0,l.jsx)(E.f5,{value:h,children:(0,l.jsx)(ep,{emoji:c??null,text:e,statusLabel:L,placeholderText:d,ref:t,...S})"
        ]
    },
    {
        "patch": 9,
        "replacement": 0,
        "module": "448368",
        "sites": [
            "(0,l.jsx)(g.R,{children:h??(0,l.jsx)(\"span\",{className:F.MK,children:u})"
        ]
    },
    {
        "patch": 10,
        "replacement": 0,
        "module": "808261",
        "sites": [
            "hideHeading:!i,headingIcon:c,children:i?(0,t.jsx)(nh,{displayProfile:l,className:nv.u}):(0,t.jsx)(nl.A,{userBio:r,setLineClamp:!1})"
        ]
    },
    {
        "patch": 11,
        "replacement": 0,
        "module": "741919",
        "sites": [
            "headingColor:\"text-strong\",children:(0,l.jsx)(ax.A,{userBio:d?.bio,userId:n.id,animateOnHoverOrFocusOnly:!0,isHoveringOrFocusing:g})"
        ]
    },
    {
        "patch": 11,
        "replacement": 1,
        "module": "741919",
        "sites": [
            "headingColor:\"text-strong\",children:(0,l.jsx)(ax.A,{userId:n.id,userBio:i.bio,isHoveringOrFocusing:r,animateOnHoverOrFocusOnly:!0})"
        ]
    },
    {
        "patch": 12,
        "replacement": 0,
        "module": "634409",
        "sites": [
            "(0,d.jsx)(_.E,{userId:i.id,userBio:K?.bio,setLineClamp:!1,textColor:\"text-strong\"})"
        ]
    }
];
