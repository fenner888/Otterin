/**
 * DevinMarkdown — renders Devin's chat replies as markdown (code blocks,
 * lists, headings, links) with theme-token styling, instead of plain text.
 */
import { Text, Linking, Platform } from 'react-native';
import Markdown, { MarkdownIt } from 'react-native-markdown-display';
import { useTheme } from '@theme/index';
import {
  InlineImage,
  InlineVideo,
  InlineAudio,
  isVideoUrl,
  isAudioUrl,
  isImageUrl,
} from '@components/InlineMedia';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const MAX_MARKDOWN_CHARACTERS = 48_000;
const MARKDOWN_PARSER = MarkdownIt({ typographer: false });
const TRUNCATION_NOTICE = '\n\n_Response shortened on this screen for safety._';

function openMarkdownLink(url: string): void {
  if (/^(?:https?:|mailto:)/i.test(url)) {
    Linking.openURL(url).catch(() => {});
  }
}

export function safeMarkdownSource(source: string): string {
  return source.length <= MAX_MARKDOWN_CHARACTERS
    ? source
    : `${source.slice(0, MAX_MARKDOWN_CHARACTERS)}${TRUNCATION_NOTICE}`;
}

type MdNode = {
  key: string;
  content?: string;
  attributes: { src?: string; href?: string; alt?: string };
  children?: MdNode[];
};
type MdStyle = { link?: object; textgroup?: object };

function renderMedia(node: MdNode, uri: string) {
  if (isVideoUrl(uri)) return <InlineVideo key={node.key} uri={uri} />;
  if (isAudioUrl(uri)) return <InlineAudio key={node.key} uri={uri} />;
  return null;
}

/** Custom renderers (module-scope so they're stable across renders). */
const MEDIA_RULES = {
  image: (node: MdNode) => {
    const src = node.attributes?.src ?? '';
    const media = renderMedia(node, src);
    if (media) return media;
    if (!isImageUrl(src)) return null;
    return <InlineImage key={node.key} uri={src} alt={node.attributes?.alt} />;
  },
  link: (node: MdNode, linkChildren: React.ReactNode, _parent: unknown, mdStyles: MdStyle) => {
    const href = node.attributes?.href ?? '';
    const media = renderMedia(node, href);
    if (media) return media;
    return (
      <Text
        key={node.key}
        style={mdStyles.link}
        onPress={() => openMarkdownLink(href)}
      >
        {linkChildren}
      </Text>
    );
  },
  textgroup: (node: MdNode, textChildren: React.ReactNode, _parent: unknown, mdStyles: MdStyle) => {
    const content =
      node.children
        ?.map((child) => child.content ?? '')
        .join('')
        .trim() ?? '';
    const media = renderMedia(node, content);
    if (media) return media;
    return (
      <Text key={node.key} style={mdStyles.textgroup}>
        {textChildren}
      </Text>
    );
  },
};

export function DevinMarkdown({ children }: { children: string }) {
  const { tokens } = useTheme();

  const styles = {
    body: { color: tokens.textHi.hex, fontSize: 14, lineHeight: 20 },
    heading1: {
      color: tokens.textHi.hex,
      fontSize: 18,
      fontWeight: '600' as const,
      marginTop: 8,
      marginBottom: 4,
    },
    heading2: {
      color: tokens.textHi.hex,
      fontSize: 16,
      fontWeight: '600' as const,
      marginTop: 8,
      marginBottom: 4,
    },
    heading3: {
      color: tokens.textHi.hex,
      fontSize: 15,
      fontWeight: '600' as const,
      marginTop: 6,
      marginBottom: 4,
    },
    strong: { color: tokens.textHi.hex, fontWeight: '700' as const },
    em: { fontStyle: 'italic' as const },
    link: { color: tokens.brandText.hex },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { color: tokens.textHi.hex, marginVertical: 2 },
    blockquote: {
      backgroundColor: tokens.surface2.hex,
      borderLeftColor: tokens.border.hex,
      borderLeftWidth: 3,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginVertical: 4,
    },
    code_inline: {
      color: tokens.textHi.hex,
      backgroundColor: tokens.surface2.hex,
      borderRadius: 4,
      paddingHorizontal: 4,
      fontFamily: MONO,
      fontSize: 13,
    },
    fence: {
      color: tokens.textHi.hex,
      backgroundColor: tokens.surface2.hex,
      borderColor: tokens.borderSubtle.hex,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginVertical: 6,
      fontFamily: MONO,
      fontSize: 12.5,
    },
    code_block: {
      color: tokens.textHi.hex,
      backgroundColor: tokens.surface2.hex,
      borderColor: tokens.borderSubtle.hex,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginVertical: 6,
      fontFamily: MONO,
      fontSize: 12.5,
    },
    hr: { backgroundColor: tokens.border.hex, height: 1, marginVertical: 8 },
    table: { borderColor: tokens.borderSubtle.hex },
    th: { color: tokens.textHi.hex, padding: 6 },
    td: { color: tokens.textMid.hex, padding: 6 },
  };

  return (
    <Markdown
      markdownit={MARKDOWN_PARSER}
      style={styles}
      rules={MEDIA_RULES}
      onLinkPress={(url) => {
        openMarkdownLink(url);
        return false;
      }}
    >
      {safeMarkdownSource(children)}
    </Markdown>
  );
}
