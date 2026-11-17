jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-video', () => ({
  VideoView: () => null,
  useVideoPlayer: jest.fn(() => ({ loop: false })),
}));
jest.mock('expo-audio', () => ({
  useAudioPlayer: jest.fn(() => ({ play: jest.fn(), pause: jest.fn() })),
  useAudioPlayerStatus: jest.fn(() => ({ playing: false })),
}));

import { Image, Linking } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { DevinMarkdown, safeMarkdownSource } from '../../src/components/DevinMarkdown';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { evalCase } from './case';

function markdown(source: string) {
  return render(
    <ThemeProvider>
      <DevinMarkdown>{source}</DevinMarkdown>
    </ThemeProvider>,
  );
}

for (const [index, url] of [
  // Deliberate adversarial fixture, never passed to a real URL opener.
  // eslint-disable-next-line no-script-url
  'javascript:alert(1)',
  'vbscript:msgbox(1)',
  'file:///synthetic/private',
  'data:text/html;base64,PHNjcmlwdD4=',
].entries()) {
  evalCase(
    {
      id: `UO-02-${index + 1}`,
      category: 'unsafe-output',
      target: 'DevinMarkdown parser + Linking',
      title: `Unsafe protocol ${url.split(':')[0]} cannot open`,
    },
    (ev) => {
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
      try {
        const view = markdown(`[fixture link](${url})`);
        const link = view.queryByText('fixture link');
        if (link) fireEvent.press(link);
        ev.record(
          { markdown: `[fixture link](${url})` },
          { openURLCalls: open.mock.calls, rendered: view.toJSON() },
        );
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );
}

for (const [index, url] of [
  'otterin://',
  'tel:5550100',
  'sms:5550100',
  'shortcuts://run-shortcut?name=fixture',
  'intent:fixture',
].entries()) {
  evalCase(
    {
      id: `UO-03-${index + 1}`,
      category: 'unsafe-output',
      target: 'DevinMarkdown custom link handler',
      title: `Custom scheme ${url.split(':')[0]} requires allowlist or confirmation`,
    },
    (ev) => {
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
      try {
        const view = markdown(`[fixture link](${url})`);
        fireEvent.press(view.getByText('fixture link'));
        ev.record({ url }, { openURLCallsWithoutConfirmation: open.mock.calls });
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );
}

evalCase(
  {
    id: 'UO-04',
    category: 'unsafe-output',
    target: 'DevinMarkdown -> InlineMedia Image',
    title: 'Remote image must not be assigned to native fetch-capable Image before consent',
  },
  (ev) => {
    const source = '![fixture beacon](https://fixture.invalid/beacon.png)';
    const view = markdown(source);
    const sources = view.UNSAFE_queryAllByType(Image).map((node) => node.props.source as unknown);
    ev.record(source, {
      imageSourcesBeforeAnyTap: sources,
      interpretation:
        'Native Image source assignment; network is blocked/mocked. No real fetch measured.',
    });
    expect(sources).toEqual([]);
  },
);

evalCase(
  {
    id: 'UO-05',
    category: 'unsafe-output',
    target: 'safeMarkdownSource + MarkdownIt HTML',
    title: 'Long markdown clipped and raw HTML not rendered as active elements',
  },
  (ev) => {
    const long = 'x'.repeat(48000) + 'SHOULD_BE_REMOVED';
    const clipped = safeMarkdownSource(long);
    const view = markdown(
      '<script>fixture()</script>\n\n<img src="https://fixture.invalid/html.png">',
    );
    const images = view.UNSAFE_queryAllByType(Image);
    ev.record(
      {
        length: long.length,
        html: '<script>fixture()</script><img src="https://fixture.invalid/html.png">',
      },
      {
        clippedLength: clipped.length,
        tail: clipped.slice(-100),
        imageCount: images.length,
        rendered: view.toJSON(),
      },
    );
    expect(clipped).not.toContain('SHOULD_BE_REMOVED');
    expect(clipped).toContain('shortened on this screen for safety');
    expect(safeMarkdownSource('')).toBe('');
    expect(images).toHaveLength(0);
  },
);
