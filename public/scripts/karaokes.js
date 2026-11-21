const CHANNEL_ID = 'UCOSx9oPg2WXFMA5CzC6HkOQ';
const CHANNEL_PATH = '/@megakaraokeoficial';
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const ORIGINAL_LINKS = {
  youtube: { name: 'YouTube', label: '', domains: ['youtube.com', 'youtu.be'] },
  spotify: { name: 'Spotify', label: '', domains: ['spotify.com', 'spotify.link'] },
  deezer: { name: 'Deezer', label: '', domains: ['deezer.com', 'deezer.page.link'] },
  appleMusic: { name: 'Apple Music', label: '', domains: ['music.apple.com', 'itunes.apple.com'] },
};

const searchInput = document.getElementById('karaoke-search');
const resultsList = document.getElementById('karaoke-results');
const statusMessage = document.getElementById('catalog-status');
const emptyMessage = document.getElementById('catalog-empty');
const player = document.getElementById('karaoke-player');
const selectedTitle = document.getElementById('selected-title');
const selectedArtist = document.getElementById('selected-artist');
const selectedAlbum = document.getElementById('selected-album');
const selectedLinks = document.getElementById('selected-links');
const playerSection = document.querySelector('.catalog-player');

const verifiedVideoIds = new Set();
let videos = [];
let matchingVideos = [];
let selectedVideoId = '';
let selectionRequest = 0;
let playerApiPromise = null;
let youtubePlayer = null;

function normalizeText(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function validateCatalog(catalog) {
  if (catalog.channelId !== CHANNEL_ID || !Array.isArray(catalog.videos)) {
    throw new Error('O catálogo não corresponde ao canal Mega Karaokê.');
  }

  const seenIds = new Set();
  return catalog.videos.map((video) => {
    if (
      typeof video.videoId !== 'string'
      || !VIDEO_ID_PATTERN.test(video.videoId)
      || typeof video.title !== 'string'
      || !video.title.trim()
      || typeof video.artist !== 'string'
      || seenIds.has(video.videoId)
    ) {
      throw new Error('O catálogo contém um vídeo inválido ou duplicado.');
    }

    seenIds.add(video.videoId);
    const visibility = video.visibility ?? 'public';
    if (!['public', 'scheduled'].includes(visibility)) {
      throw new Error(`A visibilidade de “${video.title}” não é suportada.`);
    }

    if (video.album !== undefined && typeof video.album !== 'string') {
      throw new Error(`O álbum/single de “${video.title}” precisa ser um texto.`);
    }

    const rawLinks = video.originalLinks ?? {};
    if (typeof rawLinks !== 'object' || Array.isArray(rawLinks)) {
      throw new Error(`Os links originais de “${video.title}” precisam estar em um objeto.`);
    }

    for (const provider of Object.keys(rawLinks)) {
      if (!(provider in ORIGINAL_LINKS)) {
        throw new Error(`O provedor “${provider}” não é suportado em “${video.title}”.`);
      }
    }

    const originalLinks = {};
    for (const [provider, config] of Object.entries(ORIGINAL_LINKS)) {
      const value = rawLinks[provider];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string') {
        throw new Error(`O link do ${config.name} em “${video.title}” precisa ser um texto.`);
      }

      const trimmedValue = value.trim();
      if (!trimmedValue) {
        continue;
      }

      let url;
      try {
        url = new URL(trimmedValue);
      } catch {
        throw new Error(`O link do ${config.name} em “${video.title}” não é uma URL válida.`);
      }

      const hostname = url.hostname.toLocaleLowerCase('en-US');
      const isProviderUrl = config.domains.some((domain) => (
        hostname === domain || hostname.endsWith(`.${domain}`)
      ));
      if (url.protocol !== 'https:' || !isProviderUrl) {
        throw new Error(`O link do ${config.name} em “${video.title}” precisa apontar para ${config.name}.`);
      }

      originalLinks[provider] = url.href;
    }

    return {
      videoId: video.videoId,
      title: video.title.trim(),
      artist: video.artist.trim(),
      album: video.album?.trim() ?? '',
      visibility,
      publishDate: typeof video.publishDate === 'string' ? video.publishDate.trim() : '',
      originalLinks,
    };
  });
}

function isChannelUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '').toLocaleLowerCase('en-US');
    return (
      ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname.toLocaleLowerCase('en-US'))
      && (path === CHANNEL_PATH || path === `/channel/${CHANNEL_ID.toLocaleLowerCase('en-US')}`)
    );
  } catch {
    return false;
  }
}

async function verifyChannelVideo(video) {
  if (verifiedVideoIds.has(video.videoId)) {
    return;
  }

  const metadataUrl = new URL('https://www.youtube.com/oembed');
  metadataUrl.searchParams.set('url', `https://www.youtube.com/watch?v=${video.videoId}`);
  metadataUrl.searchParams.set('format', 'json');

  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(`O YouTube não confirmou o vídeo (${response.status}).`);
  }

  const metadata = await response.json();
  if (metadata.type !== 'video' || !isChannelUrl(metadata.author_url)) {
    throw new Error('O vídeo não pertence ao canal Mega Karaokê.');
  }

  verifiedVideoIds.add(video.videoId);
}

function getSearchableText(video) {
  const links = Object.entries(video.originalLinks)
    .flatMap(([provider, url]) => (url ? [ORIGINAL_LINKS[provider].label, url] : []));
  return normalizeText([video.title, video.artist, video.album, ...links].join(' '));
}

function renderOriginalLinks(container, video) {
  container.replaceChildren();
  const serviceLinks = document.createElement('div');
  serviceLinks.className = 'original-service-links';
  for (const [provider, url] of Object.entries(video.originalLinks)) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ORIGINAL_LINKS[provider].label;
    link.title = `Ouvir no ${ORIGINAL_LINKS[provider].name}`;
    link.setAttribute('aria-label', `Ouvir no ${ORIGINAL_LINKS[provider].name}`);
    serviceLinks.append(link);
  }
  if (serviceLinks.childElementCount > 0) {
    container.append(serviceLinks);
  }
  container.hidden = container.childElementCount === 0;
}

function updateSelectedVideo(video) {
  if (selectedTitle) {
    selectedTitle.textContent = video.title;
  }
  if (selectedArtist) {
    selectedArtist.textContent = video.artist;
  }
  if (selectedAlbum) {
    selectedAlbum.textContent = video.album;
    selectedAlbum.hidden = !video.album;
  }
  if (selectedLinks) {
    renderOriginalLinks(selectedLinks, video);
  }
  selectedVideoId = video.videoId;
  player.title = `${video.title} — ${video.artist} | Mega Karaokê`;
}

function renderResults() {
  const query = normalizeText(searchInput.value.trim());
  matchingVideos = videos.filter((video) => getSearchableText(video).includes(query));

  resultsList.replaceChildren();
  emptyMessage.hidden = matchingVideos.length > 0;
  statusMessage.textContent = query
    ? `${matchingVideos.length} ${matchingVideos.length === 1 ? 'resultado' : 'resultados'}`
    : `${videos.length} ${videos.length === 1 ? 'karaokê disponível' : 'karaokês disponíveis'}`;

  for (const video of matchingVideos) {
    const item = document.createElement('li');
    item.className = 'karaoke-result-item';
    if (video.videoId === selectedVideoId) {
      item.classList.add('is-selected');
    }

    const button = document.createElement('button');
    const title = document.createElement('span');
    const artist = document.createElement('span');

    button.type = 'button';
    button.className = 'karaoke-result';
    button.setAttribute('aria-current', video.videoId === selectedVideoId ? 'true' : 'false');
    title.className = 'karaoke-result-title';
    title.textContent = video.title;
    artist.className = 'karaoke-result-artist';
    artist.textContent = video.artist;
    button.append(title, artist);
    if (video.visibility === 'scheduled') {
      const availability = document.createElement('span');
      availability.className = 'karaoke-result-availability';
      availability.textContent = video.publishDate
        ? `Programado · ${video.publishDate}`
        : 'Programado';
      button.disabled = true;
      button.append(availability);
    }
    if (video.album) {
      const album = document.createElement('span');
      album.className = 'karaoke-result-album';
      album.textContent = video.album;
      button.append(album);
    }
    button.addEventListener('click', () => selectVideo(video));
    item.append(button);
    const links = document.createElement('div');
    links.className = 'original-links result-original-links';
    links.setAttribute('aria-label', 'Links desta música');
    renderOriginalLinks(links, video);
    const karaokeLink = document.createElement('a');
    karaokeLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
    karaokeLink.target = '_blank';
    karaokeLink.rel = 'noopener noreferrer';
    karaokeLink.textContent = '';
    karaokeLink.className = 'karaoke-link-button';
    karaokeLink.title = 'Abrir karaokê no YouTube';
    karaokeLink.setAttribute('aria-label', `Abrir o karaokê de ${video.title} no YouTube`);
    links.append(karaokeLink);
    links.hidden = false;
    item.append(links);
    resultsList.append(item);
  }
}

function initializeYoutubePlayer(initialVideoId) {
  if (youtubePlayer) {
    return Promise.resolve(youtubePlayer);
  }
  if (playerApiPromise) {
    return playerApiPromise;
  }

  const currentEmbedPath = new URL(player.src).pathname.split('/').pop();
  const currentVideoId = currentEmbedPath !== 'videoseries' && VIDEO_ID_PATTERN.test(currentEmbedPath)
    ? currentEmbedPath
    : initialVideoId;
  const iframeUrl = new URL(`https://www.youtube-nocookie.com/embed/${currentVideoId}`);
  iframeUrl.searchParams.set('rel', '0');
  iframeUrl.searchParams.set('autoplay', '0');
  iframeUrl.searchParams.set('enablejsapi', '1');
  if (window.location.origin !== 'null') {
    iframeUrl.searchParams.set('origin', window.location.origin);
  }
  player.src = iframeUrl.href;

  const attempt = new Promise((resolve, reject) => {
    let settled = false;
    let readyPlayer = null;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(readyTimeout);
        reject(error);
      }
    };
    const readyTimeout = window.setTimeout(() => {
      fail(new Error('O player do YouTube não ficou pronto a tempo.'));
    }, 20000);

    window.onYouTubeIframeAPIReady = () => {
      try {
        youtubePlayer = new window.YT.Player(player, {
          events: {
            onReady(event) {
              settled = true;
              window.clearTimeout(readyTimeout);
              readyPlayer = event.target;
              youtubePlayer = readyPlayer;
              resolve(youtubePlayer);
            },
            onError(event) {
              const error = new Error(`O player do YouTube retornou o erro ${event.data}.`);
              console.error('O player do YouTube não conseguiu carregar a faixa.', error);
              statusMessage.textContent = 'O YouTube não conseguiu carregar esta faixa. Tente outra música.';
              fail(error);
            },
          },
        });
      } catch (error) {
        fail(error);
      }
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => fail(new Error('Não foi possível carregar o player do YouTube.'));
    document.head.append(script);
  });

  playerApiPromise = attempt;
  attempt.catch(() => {
    if (playerApiPromise === attempt) {
      playerApiPromise = null;
      youtubePlayer = null;
    }
  });
  return attempt;
}

async function verifyMatchingVideos(candidates) {
  const verified = [];
  const rejected = [];

  for (let start = 0; start < candidates.length; start += 5) {
    const batch = candidates.slice(start, start + 5);
    const results = await Promise.allSettled(batch.map(async (video) => {
      await verifyChannelVideo(video);
      return video;
    }));

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        verified.push(result.value);
      } else {
        rejected.push(batch[index]);
        console.error(`O vídeo “${batch[index].title}” não foi confirmado pelo YouTube.`, result.reason);
      }
    });
  }

  return { verified, rejected };
}

async function selectVideo(video) {
  if (video.visibility === 'scheduled') {
    statusMessage.textContent = 'Este vídeo ainda está programado e não pode ser reproduzido.';
    return;
  }

  const request = ++selectionRequest;
  const candidates = normalizeText(searchInput.value.trim())
    ? matchingVideos.filter((candidate) => candidate.visibility === 'public')
    : [video];
  statusMessage.textContent = `Verificando ${candidates.length} resultados no YouTube...`;

  try {
    const { verified, rejected } = await verifyMatchingVideos(candidates);
    if (request !== selectionRequest) {
      return;
    }

    const selectedIndex = verified.findIndex((candidate) => candidate.videoId === video.videoId);
    if (selectedIndex < 0) {
      throw new Error('O vídeo selecionado não foi confirmado como publicação do canal.');
    }

    const queue = [
      ...verified.slice(selectedIndex),
      ...verified.slice(0, selectedIndex),
    ];
    const readyPlayer = await initializeYoutubePlayer(video.videoId);
    if (request !== selectionRequest) {
      return;
    }

    readyPlayer.cuePlaylist(queue.map((candidate) => candidate.videoId), 0);
    readyPlayer.getIframe().title = `${video.title} — ${video.artist} | Mega Karaokê`;
    updateSelectedVideo(video);
    renderResults();
    statusMessage.textContent = rejected.length
      ? `${queue.length} resultados confirmados; ${rejected.length} não puderam ser incluídos na sequência.`
      : `${queue.length} ${queue.length === 1 ? 'resultado confirmado' : 'resultados confirmados'} na sequência.`;

    if (window.matchMedia('(max-width: 760px)').matches) {
      playerSection.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      });
    }
  } catch (error) {
    if (request !== selectionRequest) {
      return;
    }

    console.error('Não foi possível preparar a sequência de karaokês.', error);
    statusMessage.textContent = `${error.message} Tente outra música ou recarregue a página.`;
  }
}

async function loadCatalog() {
  try {
    const response = await fetch('dados/karaokes.json');
    if (!response.ok) {
      throw new Error(`Não foi possível carregar o catálogo (${response.status}).`);
    }

    const catalog = await response.json();
    videos = validateCatalog(catalog);
    if (videos.length === 0) {
      throw new Error('O catálogo ainda não contém vídeos.');
    }

    renderResults();
  } catch (error) {
    console.error('Não foi possível carregar o catálogo de karaokês.', error);
    statusMessage.textContent = 'Não foi possível carregar o catálogo. Tente recarregar a página.';
    emptyMessage.textContent = 'O catálogo está indisponível no momento.';
    emptyMessage.hidden = false;
  }
}

searchInput.addEventListener('input', () => {
  selectionRequest += 1;
  renderResults();
});
loadCatalog();
