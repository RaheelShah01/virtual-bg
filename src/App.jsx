import { useState, useEffect, useRef } from 'react';

function App() {
    // State
    const [screen, setScreen] = useState('start');
    const [loadingText, setLoadingText] = useState('Initializing...');
    const [selectedBgIndex, setSelectedBgIndex] = useState(-1);
    const [applyBlur, setApplyBlur] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');

    // Refs
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const selfieSegmentationRef = useRef(null);
    const backgroundImagesRef = useRef([]);
    const requestRef = useRef(null);
    const maskCanvasRef = useRef(null);

    // Refs for values accessed in onResults (to avoid stale closure)
    const selectedBgIndexRef = useRef(-1);
    const applyBlurRef = useRef(false);

    // Constants
    const BLUR_AMOUNT = 25;

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (requestRef.current) {
                cancelAnimationFrame(requestRef.current);
            }
            if (videoRef.current && videoRef.current.srcObject) {
                const tracks = videoRef.current.srcObject.getTracks();
                tracks.forEach(track => track.stop());
            }
        };
    }, []);

    const startApp = async () => {
        setScreen('loading');
        setLoadingText('Requesting camera access...\nPlease click "Allow" in the browser prompt.');

        try {
            const webcamPromise = startWebcam();
            const backgroundsPromise = loadBackgrounds();
            const mediaPipePromise = initializeMediaPipe();

            await Promise.all([webcamPromise, backgroundsPromise, mediaPipePromise]);

            console.log('[DEBUG] App initialized successfully');
            setScreen('video');

            console.log('[DEBUG] Starting processFrame loop...');
            processFrame();

        } catch (error) {
            console.error('Error initializing app:', error);
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                setScreen('permission');
            } else {
                setErrorMsg(error.message);
                setLoadingText(`Error: ${error.message}\nPlease refresh the page.`);
            }
        }
    };

    const startWebcam = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 },
            audio: false
        });

        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            return new Promise((resolve) => {
                videoRef.current.onloadedmetadata = () => {
                    videoRef.current.play();
                    resolve();
                };
            });
        }
    };

    const loadBackgrounds = async () => {
        const promises = [];
        for (let i = 1; i <= 6; i++) {
            promises.push(loadImage(`/backgrounds/${i}.png`));
        }
        backgroundImagesRef.current = await Promise.all(promises);
        console.log('[DEBUG] Loaded', backgroundImagesRef.current.length, 'background images');
    };

    const loadImage = (src) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load ${src}`));
            img.src = src;
        });
    };

    const initializeMediaPipe = async () => {
        let attempts = 0;
        while (!window.SelfieSegmentation && attempts < 20) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        if (!window.SelfieSegmentation) {
            throw new Error('MediaPipe failed to load. Please check your internet connection.');
        }

        const SelfieSegmentation = window.SelfieSegmentation;

        const selfieSegmentation = new SelfieSegmentation({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
            }
        });

        const isMobile = window.innerWidth < 768;
        console.log(`[DEBUG] Device detected as ${isMobile ? 'Mobile' : 'PC'}. Using modelSelection: ${isMobile ? 0 : 1}`);

        await selfieSegmentation.setOptions({
            modelSelection: isMobile ? 0 : 1,
            selfieMode: true,
        });

        console.log('[DEBUG] Registering onResults callback...');
        selfieSegmentation.onResults(onResults);
        selfieSegmentationRef.current = selfieSegmentation;
        console.log('[DEBUG] MediaPipe initialized');
    };

    const processFrame = async () => {
        if (
            videoRef.current &&
            selfieSegmentationRef.current &&
            videoRef.current.readyState === 4
        ) {
            await selfieSegmentationRef.current.send({ image: videoRef.current });
        }
        requestRef.current = requestAnimationFrame(processFrame);
    };

    const onResults = (results) => {
        const currentBgIndex = selectedBgIndexRef.current;
        const currentBlur = applyBlurRef.current;

        console.log('[onResults] Callback fired', {
            imageSize: `${results.image.width}x${results.image.height}`,
            hasMask: !!results.segmentationMask,
            selectedBg: currentBgIndex,
            blur: currentBlur
        });

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const width = results.image.width;
        const height = results.image.height;

        canvas.width = width;
        canvas.height = height;

        ctx.save();
        ctx.clearRect(0, 0, width, height);

        ctx.drawImage(results.image, 0, 0, width, height);

        if (currentBgIndex >= 0 || currentBlur) {
            ctx.globalCompositeOperation = 'destination-in';

            const isMobile = window.innerWidth < 768;

            if (!isMobile) {
                // Geometric erosion (offset intersection) to remove whitish halo
                // Only on PC. Skipped on mobile for performance/preference.
                if (!maskCanvasRef.current) {
                    maskCanvasRef.current = document.createElement('canvas');
                }
                const maskCanvas = maskCanvasRef.current;
                maskCanvas.width = width;
                maskCanvas.height = height;
                const mCtx = maskCanvas.getContext('2d');

                // Draw original mask
                mCtx.drawImage(results.segmentationMask, 0, 0, width, height);

                // Intersect with shifted versions (erosion)
                // Shift Left/Right/Down only. NOT Up (0, -offset), to preserve bottom edge.
                mCtx.globalCompositeOperation = 'destination-in';
                const offset = 2; // Approx 2px erosion
                mCtx.drawImage(results.segmentationMask, -offset, 0, width, height); // Erodes Right
                mCtx.drawImage(results.segmentationMask, offset, 0, width, height);  // Erodes Left
                mCtx.drawImage(results.segmentationMask, 0, offset, width, height);  // Erodes Top

                // Use the eroded mask
                ctx.drawImage(maskCanvas, 0, 0, width, height);
            } else {
                // Mobile: Use original mask directly (no erosion)
                ctx.drawImage(results.segmentationMask, 0, 0, width, height);
            }
            ctx.filter = 'none';

            ctx.globalCompositeOperation = 'destination-over';

            if (currentBgIndex >= 0 && currentBgIndex < backgroundImagesRef.current.length) {
                const bgImage = backgroundImagesRef.current[currentBgIndex];

                // Calculate crop to maintain aspect ratio (cover)
                const imgAspect = bgImage.width / bgImage.height;
                const canvasAspect = width / height;
                let sx, sy, sWidth, sHeight;

                if (imgAspect > canvasAspect) {
                    // Image is wider than canvas: crop sides
                    sHeight = bgImage.height;
                    sWidth = sHeight * canvasAspect;
                    sy = 0;
                    sx = (bgImage.width - sWidth) / 2;
                } else {
                    // Image is taller than canvas: crop top/bottom
                    sWidth = bgImage.width;
                    sHeight = sWidth / canvasAspect;
                    sx = 0;
                    sy = (bgImage.height - sHeight) / 2;
                }

                if (currentBlur) {
                    ctx.filter = `blur(${BLUR_AMOUNT}px)`;
                }
                ctx.drawImage(bgImage, sx, sy, sWidth, sHeight, 0, 0, width, height);
                ctx.filter = 'none';
            } else if (currentBlur) {
                ctx.filter = `blur(${BLUR_AMOUNT}px)`;
                ctx.drawImage(results.image, 0, 0, width, height);
                ctx.filter = 'none';
            }
        }

        ctx.restore();
    };

    const handleBgSelect = (index) => {
        console.log('[handleBgSelect] Selected background:', index);
        setSelectedBgIndex(index);
        selectedBgIndexRef.current = index;
    };

    const handleBlurChange = (checked) => {
        console.log('[handleBlurChange] Blur:', checked);
        setApplyBlur(checked);
        applyBlurRef.current = checked;
    };

    return (
        <div className="container">
            <div className="card" id="mainCard">

                {screen === 'start' && (
                    <div id="startScreen">
                        <div className="app-header">
                            <a href="https://techtics.ai" target="_blank" className="logo-link">
                                <img src="/logo icon.svg" alt="Techtics AI Logo" className="app-logo" />
                            </a>
                            <h2 className="app-title">Virtual Background Generator</h2>
                            <a href="https://techtics.ai" target="_blank" className="company-link">by Techtics.ai</a>
                        </div>

                        <div className="avatar-container">
                            <img src="/undraw_friendly-guy-avatar_dqp5.svg" alt="Avatar" className="avatar-img" />
                        </div>
                        <h1>Ready to Join?</h1>
                        <p>Experience seamless virtual backgrounds powered by TechticsAI.</p>
                        <button className="btn-start" onClick={startApp}>Start Camera</button>
                    </div>
                )}

                {screen === 'loading' && (
                    <div className="loading-placeholder">
                        <img src="/user icon.png" alt="Loading" className="loading-icon" />
                        <p className="loading-text">{loadingText}</p>
                    </div>
                )}

                {screen === 'permission' && (
                    <div id="permissionDeniedScreen">
                        <div className="app-header">
                            <h2 className="app-title" style={{ color: '#ef4444' }}>Camera Permission Denied</h2>
                        </div>
                        <div className="avatar-container">
                            <div style={{ fontSize: '64px', marginBottom: '20px' }}>🚫</div>
                        </div>
                        <p style={{ marginBottom: '10px' }}>Please allow camera access in your browser settings.</p>
                        <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '30px' }}>Click the lock icon 🔒 in the address bar to enable permissions.</p>
                        <button className="btn-start" onClick={() => window.location.reload()}>Try Again</button>
                    </div>
                )}

                <div id="videoScreen" className={screen === 'video' ? 'visible' : 'hidden'}>
                    <div className="video-container">
                        <video
                            ref={videoRef}
                            id="webcam"
                            autoPlay
                            playsInline
                            style={{ display: 'none' }}
                        ></video>
                        <canvas ref={canvasRef} id="outputCanvas"></canvas>
                    </div>

                    <div className="controls-container">
                        <div className="blur-toggle">
                            <label className="switch">
                                <input
                                    type="checkbox"
                                    checked={applyBlur}
                                    onChange={(e) => handleBlurChange(e.target.checked)}
                                />
                                <span className="slider round"></span>
                            </label>
                            <span>Blur Background</span>
                        </div>

                        <div className="thumbnails-grid">
                            <div
                                className="thumbnail-wrapper"
                                onClick={() => handleBgSelect(-1)}
                                style={{ cursor: 'pointer' }}
                            >
                                <img
                                    src="/backgrounds/no_bg.png"
                                    alt="No BG"
                                    className={`bg-thumbnail ${selectedBgIndex === -1 ? 'active' : ''}`}
                                    style={{ cursor: 'pointer' }}
                                />
                            </div>

                            {[1, 2, 3, 4, 5, 6].map((num, index) => (
                                <div
                                    key={num}
                                    className="thumbnail-wrapper"
                                    onClick={() => handleBgSelect(index)}
                                    style={{ cursor: 'pointer' }}
                                >
                                    <img
                                        src={`/backgrounds/${num}.png`}
                                        alt={`BG ${num}`}
                                        className={`bg-thumbnail ${selectedBgIndex === index ? 'active' : ''}`}
                                        style={{ cursor: 'pointer' }}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}

export default App;
