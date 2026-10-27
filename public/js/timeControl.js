import { formatFullUTC } from './utils.js';

const SPEED_PRESETS = [1, 10, 60, 300, 1800, 3600];

/**
 * Owns the simulated clock: whether it's running, how fast it moves
 * relative to real time, and renders the play/pause + speed-preset buttons
 * into the footer.
 */
export class TimeController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.playPauseButton
   * @param {HTMLElement} opts.resetButton
   * @param {HTMLElement} opts.speedContainer
   * @param {HTMLElement} opts.simTimeLabel
   * @param {HTMLElement} opts.clockLabel
   */
  constructor({ playPauseButton, resetButton, speedContainer, simTimeLabel, clockLabel }) {
    this.simDate = new Date();
    this.playing = true;
    this.speed = 1;

    this.playPauseButton = playPauseButton;
    this.resetButton = resetButton;
    this.speedContainer = speedContainer;
    this.simTimeLabel = simTimeLabel;
    this.clockLabel = clockLabel;

    this._iconPause = playPauseButton.querySelector('#icon-pause');
    this._iconPlay = playPauseButton.querySelector('#icon-play');

    this._buildSpeedButtons();
    this._wireControls();
    this._renderTimeLabel();
  }

  _buildSpeedButtons() {
    this.speedContainer.innerHTML = '';
    this._speedButtons = new Map();
    for (const speed of SPEED_PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'speed-btn';
      btn.textContent = `${speed}x`;
      btn.setAttribute('aria-pressed', String(speed === this.speed));
      btn.addEventListener('click', () => this.setSpeed(speed));
      this.speedContainer.appendChild(btn);
      this._speedButtons.set(speed, btn);
    }
    this._refreshSpeedButtons();
  }

  _refreshSpeedButtons() {
    for (const [speed, btn] of this._speedButtons) {
      const active = speed === this.speed;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  _wireControls() {
    this.playPauseButton.addEventListener('click', () => this.togglePlay());
    this.resetButton.addEventListener('click', () => this.resetToNow());
  }

  togglePlay() {
    this.playing = !this.playing;
    this._iconPause.classList.toggle('hidden', !this.playing);
    this._iconPlay.classList.toggle('hidden', this.playing);
  }

  setSpeed(speed) {
    this.speed = speed;
    this._refreshSpeedButtons();
  }

  resetToNow() {
    this.simDate = new Date();
    this.playing = true;
    this._iconPause.classList.remove('hidden');
    this._iconPlay.classList.add('hidden');
    this._renderTimeLabel();
  }

  /**
   * Advances the simulated clock by `realDeltaMs` of wall-clock time,
   * scaled by the current time-warp speed (a no-op while paused).
   * @param {number} realDeltaMs
   */
  tick(realDeltaMs) {
    if (this.playing) {
      this.simDate = new Date(this.simDate.getTime() + realDeltaMs * this.speed);
    }
    this._renderTimeLabel();
  }

  _renderTimeLabel() {
    this.simTimeLabel.textContent =
      this.speed === 1 ? formatFullUTC(this.simDate) : `${formatFullUTC(this.simDate)}  ·  ${this.speed}x`;
    if (this.clockLabel) {
      this.clockLabel.textContent = this.simDate.toISOString().substring(11, 19);
    }
  }
}
