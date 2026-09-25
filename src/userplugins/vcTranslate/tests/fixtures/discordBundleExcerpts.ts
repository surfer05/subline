/**
 * The smallest pieces of Discord's public web client (discord.com/assets,
 * fetched with no login on 2026-09-25) each surface patch match needs: for
 * each replacement, per site, just the matched text plus any context its
 * lookbehind or lookahead reads. Regression fixtures for
 * tests/surfacePatches.test.ts; the full-bundle check (every find in exactly
 * one module, every match at these sites and nowhere else) was run by hand.
 */
export const BUNDLE_SITES: Array<{ patch: number; replacement: number; module: string; sites: string[]; }> = [
    {
        "patch": 0,
        "replacement": 0,
        "module": "465829",
        "sites": [
            "children:[l,\" \",c]"
        ]
    },
    {
        "patch": 1,
        "replacement": 0,
        "module": "46054",
        "sites": [
            "parseTopic:(e,t,n,l)=>T()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseTruncatedTopic:"
        ]
    },
    {
        "patch": 1,
        "replacement": 1,
        "module": "46054",
        "sites": [
            "parseTruncatedTopic:(e,t,n,l)=>R()(e,t,{allowLinks:!0,allowGameMentions:!0,...n},l),parseVoiceChannelStatus:"
        ]
    },
    {
        "patch": 1,
        "replacement": 2,
        "module": "46054",
        "sites": [
            "parseVoiceChannelStatus:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return O()(...t)}"
        ]
    },
    {
        "patch": 1,
        "replacement": 3,
        "module": "46054",
        "sites": [
            "parseGuildVerificationFormRule:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return w()(...t)}"
        ]
    },
    {
        "patch": 1,
        "replacement": 4,
        "module": "46054",
        "sites": [
            "parseForumPostGuidelines:function(){for(var e=arguments.length,t=Array(e),n=0;n<e;n++)t[n]=arguments[n];return U()(...t)}"
        ]
    },
    {
        "patch": 2,
        "replacement": 0,
        "module": "435328",
        "sites": [
            "d=i.A.reactParserFor({...l,link:s,channelMention:o})"
        ]
    },
    {
        "patch": 3,
        "replacement": 0,
        "module": "542308",
        "sites": [
            "renderSubtitle=()=>{let e=this.props.stageInstance?.topic;return null==e?null:(0,s.jsx)(tX.A,{children:e})"
        ]
    },
    {
        "patch": 3,
        "replacement": 1,
        "module": "542308",
        "sites": [
            "__invalid_threadMainContent),children:[(0,s.jsx)(e5.E,{variant:\"text-sm/medium\",color:\"none\",className:n$.UU,children:(0,s.jsx)(tX.A,{\"aria-hidden\":!0,children:A})"
        ]
    },
    {
        "patch": 4,
        "replacement": 0,
        "module": "350527",
        "sites": [
            "(\"span\",{ref:h,children:[u,o&&(0,s.jsx)(\"span\""
        ]
    },
    {
        "patch": 5,
        "replacement": 0,
        "module": "52933",
        "sites": [
            "useManaTagGroup:y}):null]}):null"
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
    }
];
