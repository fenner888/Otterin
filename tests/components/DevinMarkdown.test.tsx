/**
 * Smoke test for the markdown renderer — renders code/lists/links without
 * throwing and surfaces the text content.
 */
const mockAudioPlayer = { play: jest.fn(), pause: jest.fn() };

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: jest.fn(() => ({ top: 0, right: 0, bottom: 0, left: 0 })),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('expo-video', () => ({
  VideoView: () => {
    const React = jest.requireActual('react');
    const { View } = jest.requireActual('react-native');
    return React.createElement(View, { accessibilityLabel: 'Inline video' });
  },
  useVideoPlayer: jest.fn(() => ({ loop: false })),
}));

jest.mock('expo-audio', () => ({
  useAudioPlayer: jest.fn(() => mockAudioPlayer),
  useAudioPlayerStatus: jest.fn(() => ({
    playing: false,
    isLoaded: true,
    currentTime: 0,
    duration: 0,
  })),
}));

import { Image, Linking } from 'react-native';
import { useAudioPlayer } from 'expo-audio';
import { fireEvent, render } from '@testing-library/react-native';
import { DevinMarkdown, safeMarkdownSource } from '../../src/components/DevinMarkdown';
import { InlineImage, isVideoUrl, isAudioUrl, isImageUrl } from '../../src/components/InlineMedia';
import { ThemeProvider } from '../../src/theme/ThemeProvider';

function fallbackLinkHandler(view: ReturnType<typeof render>): (url: string) => boolean {
  return view.UNSAFE_root.find(
    (node: { props: Record<string, unknown> }) => typeof node.props.onLinkPress === 'function',
  ).props.onLinkPress;
}

describe('DevinMarkdown', () => {
  it.each([
    'http://example.invalid/fixture',
    'https://example.invalid/fixture',
    'mailto:fixture@example.invalid',
    'HTTPS://example.invalid/fixture',
  ])('opens allowlisted Markdown links in both handlers: %s', (url) => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    try {
      const view = render(
        <ThemeProvider>
          <DevinMarkdown>{`[Fixture](${url})`}</DevinMarkdown>
        </ThemeProvider>,
      );
      fireEvent.press(view.getByText('Fixture'));
      expect(open).toHaveBeenCalledTimes(1);
      open.mockClear();
      expect(fallbackLinkHandler(view)(url)).toBe(false);
      expect(open).toHaveBeenCalledWith(url);
    } finally {
      open.mockRestore();
    }
  });

  it.each([
    'otterin://',
    'tel:5550100',
    'sms:5550100',
    'shortcuts://run-shortcut?name=fixture',
    'intent:fixture',
    'file:///synthetic/private',
    'data:text/html;base64,ZmFrZQ==',
    '//example.invalid/fixture',
    '/relative',
  ])('blocks non-allowlisted Markdown links in both handlers: %s', (url) => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    try {
      const view = render(
        <ThemeProvider>
          <DevinMarkdown>{`[Fixture](${url})`}</DevinMarkdown>
        </ThemeProvider>,
      );
      const link = view.queryByText('Fixture');
      if (link) fireEvent.press(link);
      expect(fallbackLinkHandler(view)(url)).toBe(false);
      expect(fallbackLinkHandler(view)('')).toBe(false);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('handles rejected URL opens without throwing', async () => {
    const open = jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('Synthetic unavailable'));
    try {
      const view = render(
        <ThemeProvider>
          <DevinMarkdown>[Fixture](https://example.invalid/fixture)</DevinMarkdown>
        </ThemeProvider>,
      );
      fireEvent.press(view.getByText('Fixture'));
      await Promise.resolve();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it('bounds exceptionally long remote markdown before parsing', () => {
    const source = '"'.repeat(160_000);
    const safe = safeMarkdownSource(source);
    expect(safe.length).toBeLessThan(50_000);
    expect(safe).toContain('shortened on this screen for safety');
  });
  it('renders markdown content (code, list) without crashing', () => {
    const md = '# Title\n\nSome **bold** text.\n\n- item one\n- item two\n\n`inline code`';
    const { getByText } = render(
      <ThemeProvider>
        <DevinMarkdown>{md}</DevinMarkdown>
      </ThemeProvider>,
    );
    expect(getByText('Title')).toBeTruthy();
    expect(getByText('item one')).toBeTruthy();
  });

  it('renders an image with its markdown alt text', () => {
    const { getByLabelText } = render(
      <ThemeProvider>
        <DevinMarkdown>![Architecture diagram](https://x.com/diagram.png)</DevinMarkdown>
      </ThemeProvider>,
    );
    expect(getByLabelText('Architecture diagram')).toBeTruthy();
  });

  it('renders bare video and audio links as inline media', () => {
    const audioUrl = 'https://x.com/clip.m4a?token=1';
    const { getByLabelText } = render(
      <ThemeProvider>
        <DevinMarkdown>{`https://x.com/demo.mp4\n\n${audioUrl}`}</DevinMarkdown>
      </ThemeProvider>,
    );
    expect(getByLabelText('Inline video')).toBeTruthy();
    fireEvent.press(getByLabelText('Play audio'));
    expect(useAudioPlayer).toHaveBeenCalledWith(audioUrl);
    expect(mockAudioPlayer.play).toHaveBeenCalledTimes(1);
  });
});

describe('InlineImage', () => {
  it('opens and closes the full-screen viewer', () => {
    const { getByLabelText, queryByLabelText } = render(
      <ThemeProvider>
        <InlineImage uri="https://x.com/image.png" alt="Screenshot" />
      </ThemeProvider>,
    );
    fireEvent.press(getByLabelText('Screenshot'));
    expect(getByLabelText('Close image')).toBeTruthy();
    fireEvent.press(getByLabelText('Close image'));
    expect(queryByLabelText('Close image')).toBeNull();
  });

  it('shows a non-interactive fallback without exposing the URI', () => {
    const uri = 'https://x.com/image.png?token=secret';
    const { UNSAFE_getByType, getByText, queryByText } = render(
      <ThemeProvider>
        <InlineImage uri={uri} />
      </ThemeProvider>,
    );
    fireEvent(UNSAFE_getByType(Image), 'error');
    expect(getByText('Image unavailable')).toBeTruthy();
    expect(queryByText(uri)).toBeNull();
  });
});

describe('media URL detection', () => {
  it('detects supported HTTPS media extensions with query strings and fragments', () => {
    expect(isVideoUrl('https://x.com/a.mp4')).toBe(true);
    expect(isVideoUrl('https://x.com/a.mov?t=1')).toBe(true);
    expect(isAudioUrl('https://x.com/a.mp3')).toBe(true);
    expect(isAudioUrl('https://x.com/a.m4a#frag')).toBe(true);
    expect(isImageUrl('https://x.com/a.png')).toBe(true);
  });

  it('rejects unsupported extensions and unsafe schemes', () => {
    expect(isVideoUrl('https://x.com/a.png')).toBe(false);
    expect(isAudioUrl('https://x.com/a.png')).toBe(false);
    expect(isVideoUrl('ftp://x.com/a.mp4')).toBe(false);
    expect(isVideoUrl('http://x.com/a.mp4')).toBe(false);
    expect(isAudioUrl('file:///tmp/a.mp3')).toBe(false);
    expect(isImageUrl('http://x.com/a.png')).toBe(false);
    expect(isImageUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });
});
