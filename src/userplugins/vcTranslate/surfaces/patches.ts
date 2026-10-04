/**
 * The webpack patches that put surface translations where Discord shows the
 * text. Every one was checked against Discord's current public web bundle
 * (fetched from discord.com/app, no login) before it was written here: each
 * `find` hits exactly one module and each `match` matches exactly once in it
 * (the two onboarding prompt headings are one global match, two sites).
 *
 * FAIL SAFE BY CONSTRUCTION. No patch is grouped, so each replacement stands
 * alone: if Discord moves one piece of code, Vencord logs one "had no effect"
 * warning for that replacement and every other surface keeps working. Every
 * inserted call is a `$self` method that returns Discord's own value
 * UNCHANGED (the same child, or null where a child is appended) when the
 * install is not paid, when the text is not in a server, when the input is
 * not what it expects, or when anything throws.
 *
 * Plain data, so tests and the bundle check can import it without Discord.
 */

export interface SurfacePatch {
    /** What this patch is for, for the report and the tests. */
    surface: string;
    /** Where the find/match came from. */
    source: string;
    find: string;
    replacement: Array<{ match: RegExp; replace: string; }>;
}

const PARSER_FN = String.raw`function\(\)\{[^{}]*\}`;
const PARSER_ARROW = String.raw`\(\i,\i,\i,\i\)=>\i\(\)\(\i,\i,\{[^{}]*\},\i\)`;

export const SURFACE_PATCHES: SurfacePatch[] = [
    {
        surface: "channel topic (header: translated in place; topic popout and welcome header: line), voice channel status (in place), server rules (line), forum guidelines (line)",
        source: "Discord's markup parser module, the object Vencord exposes as `Parser` (webpack/common, findByProps(\"parseTopic\"))",
        find: "parseVoiceChannelStatus:function",
        replacement: [
            {
                match: new RegExp(String.raw`(?<=parseTopic:)(${PARSER_ARROW})(?=,parseTruncatedTopic:)`),
                replace: "$self.wrapParser(\"topic\",$1)"
            },
            {
                match: new RegExp(String.raw`(?<=parseTruncatedTopic:)(${PARSER_ARROW})(?=,parseVoiceChannelStatus:)`),
                replace: "$self.wrapParser(\"topic-truncated\",$1)"
            },
            {
                match: new RegExp(String.raw`(?<=parseVoiceChannelStatus:)(${PARSER_FN})`),
                replace: "$self.wrapParser(\"voice-status\",$1)"
            },
            {
                match: new RegExp(String.raw`(?<=parseGuildVerificationFormRule:)(${PARSER_FN})`),
                replace: "$self.wrapParser(\"rule\",$1)"
            },
            {
                match: new RegExp(String.raw`(?<=parseForumPostGuidelines:)(${PARSER_FN})`),
                replace: "$self.wrapParser(\"guidelines\",$1)"
            }
        ]
    },
    {
        surface: "scheduled event description (line)",
        source: "Discord's guild event description parser (reactParserFor over Parser.guildEventRules)",
        find: "guildEventLocationRules,link:",
        replacement: [{
            match: /(?<=\i=)(\i\.\i\.reactParserFor\(\{\.\.\.\i,link:\i,channelMention:\i\}\))/,
            replace: "$self.wrapParser(\"event\",$1)"
        }]
    },
    {
        surface: "stage topic in the channel list (in place), thread titles in the channel list (in place)",
        source: "find from Equicord src/equicordplugins/dragify/index.tsx (\"__invalid_threadMainContent\"); matches written against the current bundle",
        find: "__invalid_threadMainContent",
        replacement: [
            {
                // The stage row's subtitle: the props of Discord's own
                // OverflowTooltip, exactly { children } for anyone not paid.
                match: /(renderSubtitle=\(\)=>\{let (\i)=this\.props\.stageInstance\?\.topic;return null==\2\?null:\(0,\i\.jsx\)\(\i\.\i,\{)children:\2\}/,
                replace: "$1...$self.stageTopicProps($2,this.props.channel)}"
            },
            {
                // The thread row's name: the props of Discord's own
                // OverflowTooltip, exactly { children } for anyone not paid.
                match: /(__invalid_threadMainContent\),children:\[\(0,\i\.jsx\)\(\i\.\i,\{variant:"text-sm\/medium",color:"none",className:\i\.\i,children:\(0,\i\.jsx\)\(\i\.\i,\{"aria-hidden":!0,)children:(\i)\}/,
                replace: "$1...$self.threadTitleProps($2,arguments[0]?.thread)}"
            }
        ]
    },
    {
        surface: "forum post card title (in place)",
        source: "written against the current bundle (the forum post card)",
        find: "postTitleRef:",
        replacement: [{
            match: /(?<=\("span",\{ref:\i,children:\[)(\i)(?=,\i&&\(0,\i\.jsx\)\("span")/,
            replace: "$self.forumTitleChildren($1,arguments[0]?.channel)"
        }]
    },
    {
        surface: "forum tag names (in place, in every tag pill)",
        source: "written against the current bundle (the forum tag pill)",
        find: "forum-tag-",
        replacement: [{
            match: /(lineClamp:1,color:"currentColor",children:)(\i)(?=\}\)\]\}\),\i=\{key:\i\.id)/,
            replace: "$1$self.forumTagChildren($2)"
        }]
    },
    {
        surface: "custom status in the member list and DM list (in place)",
        source: "written against the current bundle (Discord's ActivityStatus, the custom status text)",
        find: "location:\"CustomStatusVoiceDare\"",
        replacement: [{
            match: /(?<=let \i=\i&&)(\(null!=\i\?` \$\{(\i)\}`:\2\))/,
            replace: "$self.statusTextChildren($1,$2)"
        }]
    },
    {
        surface: "profile bio in the About Me section (popout, DM side profile redesign): translated in place, with a toggle",
        source: "written against the current bundle (the About Me section: its measuring div wraps the bio renderer, so the \"View full bio\" check counts the translation and the toggle)",
        find: "getBoundingClientRect().height>57.75",
        replacement: [{
            match: /(\(0,\i\.jsx\)\(\i\.A,\{userId:\i,userBio:(\i),setLineClamp:!1,textColor:"text-strong",animateOnHoverOrFocusOnly:\i,isHoveringOrFocusing:\i\}\))/,
            replace: "$self.bioInPlace($1,$2)"
        }]
    },
    {
        surface: "onboarding prompt question and options (line under the question)",
        source: "written against the current bundle (the onboarding flow)",
        find: "gotoNextPrompt:",
        replacement: [{
            match: /(\(0,\i\.jsx\)\(\i\.\i,\{className:\i\.\i,variant:"heading-xl\/semibold",color:"text-strong",id:\i,children:(\i)\.title\}\))/g,
            replace: "$self.onboardingHeading($1,$2)"
        }]
    },
    {
        surface: "custom status in the profile header: the translation IN PLACE of the status text, with a toggle at its end",
        source: "written against the current bundle (the profile custom status bubble). The status text element is built once and rendered in every copy (the hidden reference, the clamped and the full measuring copies, and the visible animated one), so Discord's own 2-line clamp, chevron and expand work on the translation",
        find: "action:\"HOVER_CUSTOM_STATUS\"",
        replacement: [
            {
                // The status text: `null!=r?<Text …>{r}</Text>:null`, then the
                // placeholder. arguments[0] is the bubble's props (its
                // forwardRef body): who it belongs to rides on them (below).
                match: /(\i=null!=(\i)\?\(0,\i\.jsx\)\(\i\.\i,\{variant:"text-sm\/normal",className:\i\.\i,children:)\2\}\):null,(?=\i=void 0!==)/,
                replace: "$1$self.statusBubbleText($2,arguments[0])}):null,"
            },
            {
                // The bubble measures its copies once per change of its own
                // inputs. This adds "a translation landed or a toggle flipped"
                // to them, so the clamp and the chevron follow what is shown.
                match: /(maxHeight:`\$\{\i\?Math\.min\(\i\.current,\i\):\i\}px`\}\)\},\[\i,\i,\i,\i,\i,\i,\i)\]/,
                replace: "$1,$self.useSurfaceVersion()]"
            },
            {
                // The outer component knows whose status this is and whether
                // it is the reader's own (the live preview while typing one is
                // always theirs). Its rest props reach the bubble in every
                // branch, so both ride along on them: own status and own
                // typing are never translated, and a toggle is per user.
                match: /(?<=(\i)=!(\i)&&!(\i)\.bot&&!\i;)if\((\i)\)\{(?=let \i=null!=\i&&""!==\i\?\i:null;return\(0,\i\.jsx\)\(\i\.\i,\{value:\i,children:\(0,\i\.jsx\)\(\i,\{emoji:\i\?\?null,text:\i,statusLabel:\i,placeholderText:\i,ref:\i,\.\.\.(\i)\}\))/,
                replace: "if($5.sublineSelf=$2,$5.sublineUser=$3?.id,$4){"
            }
        ]
    },
    {
        surface: "reply bar: the quoted line, translated in place",
        source: "find from Vencord src/plugins/replyTimestamp/index.tsx; match written against the current bundle",
        find: "#{intl::REPLY_QUOTE_MESSAGE_NOT_LOADED}",
        replacement: [{
            match: /(?<=\(0,\i\.jsx\)\(\i\.R,\{children:)(\i)(?=\?\?\(0,\i\.jsx\)\("span",\{className:\i\.\i,children:\i\}\))/,
            replace: "$self.replyQuoteChildren($1,arguments[0])"
        }]
    },
    {
        surface: "profile bio in the full profile (modal): translated in place, with a toggle",
        source: "written against the current bundle (UserProfileModalV2 renders the bio renderer directly, not the About Me wrapper the popout uses)",
        find: "friendsSinceDate:",
        replacement: [{
            match: /(?<=hideHeading:!\i,headingIcon:\i,children:\i\?\(0,\i\.jsx\)\(\i,\{displayProfile:\i,className:\i\.\i\}\):)(\(0,\i\.jsx\)\(\i\.\i,\{userBio:(\i),setLineClamp:!1\}\))/,
            // The renderer here carries no userId: the profile's own does.
            replace: "$self.bioInPlace($1,$2,arguments[0]?.displayProfile?.userId)"
        }]
    },
    {
        surface: "profile bio in the DM side profile (non-redesign layout): translated in place, with a toggle, both About Me sites",
        source: "written against the current bundle (the DM side panel module; its redesign branch uses the About Me wrapper and is covered by the popout patch)",
        find: "DMSidePanelWishlistItemCard",
        replacement: [
            {
                match: /(?<=headingColor:"text-strong",children:)(\(0,\i\.jsx\)\(\i\.A,\{userBio:(\i\?\.bio),userId:\i\.id,animateOnHoverOrFocusOnly:!0,isHoveringOrFocusing:\i\}\))/,
                replace: "$self.bioInPlace($1,$2)"
            },
            {
                match: /(?<=headingColor:"text-strong",children:)(\(0,\i\.jsx\)\(\i\.A,\{userId:\i\.id,userBio:(\i\.bio),isHoveringOrFocusing:\i,animateOnHoverOrFocusOnly:!0\}\))/,
                replace: "$self.bioInPlace($1,$2)"
            }
        ]
    },
    {
        surface: "profile bio in the minimal user popout: translated in place, with a toggle",
        source: "written against the current bundle (a popout variant that renders the bio renderer directly)",
        find: "setLineClamp:!1,textColor:\"text-strong\"}",
        replacement: [{
            match: /(\(0,\i\.jsx\)\(\i\.E,\{userId:\i\.id,userBio:(\i\?\.bio),setLineClamp:!1,textColor:"text-strong"\}\))/,
            replace: "$self.bioInPlace($1,$2)"
        }]
    }
];
