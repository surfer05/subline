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
 * inserted call is a `$self` method that returns the original value (or
 * nothing) when the install is not paid, when the input is not what it
 * expects, or when anything throws.
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
        surface: "profile name row: custom status (tight)",
        source: "Vencord src/plugins/userVoiceShow/index.tsx (same find and match)",
        find: "#{intl::USER_PROFILE_PRONOUNS}",
        replacement: [{
            match: /(?<=children:\[\i," ",\i)(?=\])/,
            replace: ",$self.renderProfileSurface(arguments[0])"
        }]
    },
    {
        surface: "channel topic (header: tight; topic popout and welcome header: line), voice channel status (tight), server rules (line), forum guidelines (line)",
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
        surface: "stage topic in the channel list (tight), thread titles in the channel list (tight)",
        source: "find from Equicord src/equicordplugins/dragify/index.tsx (\"__invalid_threadMainContent\"); matches written against the current bundle",
        find: "__invalid_threadMainContent",
        replacement: [
            {
                match: /(renderSubtitle=\(\)=>\{let (\i)=this\.props\.stageInstance\?\.topic;return null==\2\?null:\(0,\i\.jsx\)\(\i\.\i,\{children:)\2\}/,
                replace: "$1[$self.renderSurfaceMark(\"stage-topic\",$2),$2]}"
            },
            {
                match: /(__invalid_threadMainContent\),children:\[\(0,\i\.jsx\)\(\i\.\i,\{variant:"text-sm\/medium",color:"none",className:\i\.\i,children:\(0,\i\.jsx\)\(\i\.\i,\{"aria-hidden":!0,children:)(\i)\}/,
                replace: "$1[$self.renderSurfaceMark(\"thread-title\",arguments[0]?.thread?.name),$2]}"
            }
        ]
    },
    {
        surface: "forum post card title (tight)",
        source: "written against the current bundle (the forum post card)",
        find: "postTitleRef:",
        replacement: [{
            match: /(?<=\("span",\{ref:\i,children:\[\i)(?=,\i&&\(0,\i\.jsx\)\("span")/,
            replace: ",$self.renderSurfaceMark(\"thread-title\",arguments[0]?.channel?.name)"
        }]
    },
    {
        surface: "forum post tags (tight)",
        source: "written against the current bundle (the forum post tags row)",
        find: "\"forum-post-tags\"",
        replacement: [{
            match: /(?<=useManaTagGroup:\i\}\):null)(?=\]\}\):null)/,
            replace: ",$self.renderForumTagsMark(arguments[0]?.channel)"
        }]
    },
    {
        surface: "profile bio (line under the bio: popout, full profile, DM side profile)",
        source: "written against the current bundle (the About Me section every profile surface renders)",
        find: "getBoundingClientRect().height>57.75",
        replacement: [{
            match: /(?<=isHoveringOrFocusing:\i\}\)\}\))(?=,\(\i\|\|\i\)&&)/,
            replace: ",$self.renderBioLine(arguments[0])"
        }]
    },
    {
        surface: "onboarding prompt question and options (line under the question)",
        source: "written against the current bundle (the onboarding flow)",
        find: "gotoNextPrompt:",
        replacement: [{
            match: /(variant:"heading-xl\/semibold",color:"text-strong",id:\i,children:(\i)\.title\}\))/g,
            replace: "$1,$self.renderOnboardingPrompt($2)"
        }]
    }
];
