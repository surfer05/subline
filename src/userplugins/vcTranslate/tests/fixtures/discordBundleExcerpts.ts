/**
 * The smallest pieces of Discord's public web client (discord.com/assets,
 * fetched with no login on 2026-09-27) each surface patch match needs: for
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
            "isHoveringOrFocusing:S})}),(R||v)&&"
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
        "module": "983495",
        "sites": [
            "es=null!=a?(0,l.jsx)(f.E,{variant:\"text-sm/normal\",className:eu.qS,children:a}):null,eo=void 0!=="
        ]
    },
    {
        "patch": 8,
        "replacement": 1,
        "module": "983495",
        "sites": [
            "maxHeight:`${B?Math.min(V.current,_):n}px`})},[X,a,n,er,B,_,Z]"
        ]
    },
    {
        "patch": 9,
        "replacement": 0,
        "module": "448368",
        "sites": [
            "(0,l.jsx)(g.R,{children:h??(0,l.jsx)(\"span\",{className:F.MK,children:u})"
        ]
    }
];
