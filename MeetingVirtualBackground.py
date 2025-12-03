"""
Virtual Background Generator - Flask Application
A web application that applies virtual backgrounds and blur effects to webcam feed using MediaPipe.
"""

from flask import Flask, render_template, Response
import cv2
import mediapipe as mp
import numpy as np
import os
import time

# Initialize Flask app
app = Flask(__name__)

# Constants
BACKGROUND_FOLDER = os.path.join('static', 'backgrounds')
NUM_BACKGROUNDS = 6
BLUR_KERNEL_SIZE = (55, 55)
SEGMENTATION_THRESHOLD = 0.1

# Global state variables
selected_bg_index = -1  # -1 means no background selected (original camera feed)
apply_blur = False  # Blur toggle state
background_images = []  # Cached background images

# Initialize MediaPipe Selfie Segmentation
mp_selfie_segmentation = mp.solutions.selfie_segmentation


def load_backgrounds():
    """
    Load all background images from the backgrounds folder.
    Creates placeholder images if files don't exist.
    """
    global background_images
    
    # Ensure background folder exists
    if not os.path.exists(BACKGROUND_FOLDER):
        os.makedirs(BACKGROUND_FOLDER)
    
    background_images = []
    
    # Load images 1.png to 6.png
    for i in range(1, NUM_BACKGROUNDS + 1):
        img_path = os.path.join(BACKGROUND_FOLDER, f'{i}.png')
        
        if os.path.exists(img_path):
            bg = cv2.imread(img_path)
            background_images.append(bg)
        else:
            # Create a colorful gradient placeholder if image doesn't exist
            placeholder = create_placeholder_background(i)
            background_images.append(placeholder)


def create_placeholder_background(bg_number):
    """
    Create a gradient placeholder background image.
    
    Args:
        bg_number (int): Background number for labeling
        
    Returns:
        numpy.ndarray: Placeholder background image
    """
    placeholder = np.zeros((480, 640, 3), dtype=np.uint8)
    
    # Create gradient effect
    for y in range(480):
        r = int(255 * y / 480)
        g = int(255 * (480 - y) / 480)
        b = 128
        placeholder[y, :] = (b, g, r)
    
    # Add text label
    cv2.putText(placeholder, f'BG {bg_number}', (250, 250), 
                cv2.FONT_HERSHEY_PLAIN, 2, (255, 255, 255), 2)
    
    return placeholder


@app.route('/')
def index():
    """
    Render the main page and reset application state.
    """
    global selected_bg_index, apply_blur
    selected_bg_index = -1
    apply_blur = False
    return render_template('index.html')


@app.route('/set_background/<bg_index>')
def set_background(bg_index):
    """
    Set the selected background image.
    
    Args:
        bg_index (str): Background index (-1 for no background, 0-5 for backgrounds)
        
    Returns:
        dict: JSON response with status
    """
    global selected_bg_index
    
    try:
        bg_index = int(bg_index)
    except ValueError:
        return {'status': 'error', 'message': 'Invalid index format'}, 400
    
    # Validate index range
    if bg_index == -1 or (0 <= bg_index < len(background_images)):
        selected_bg_index = bg_index
        return {'status': 'success', 'selected_index': bg_index}
    
    return {'status': 'error', 'message': 'Invalid index'}, 400


@app.route('/toggle_blur/<int:state>')
def toggle_blur(state):
    """
    Toggle blur effect on/off.
    
    Args:
        state (int): 1 to enable blur, 0 to disable
        
    Returns:
        dict: JSON response with status
    """
    global apply_blur
    apply_blur = bool(state)
    return {'status': 'success', 'blur_enabled': apply_blur}


def gen_frames():
    """
    Generate video frames with background replacement and blur effects.
    
    Yields:
        bytes: JPEG-encoded video frames in multipart format
    """
    cap = cv2.VideoCapture(0)
    prev_time = 0
    
    with mp_selfie_segmentation.SelfieSegmentation(model_selection=0) as selfie_segmentation:
        while cap.isOpened():
            success, image = cap.read()
            if not success:
                print("Warning: Empty camera frame received")
                break
            
            # Flip image horizontally for selfie-view and convert to RGB
            image = cv2.cvtColor(cv2.flip(image, 1), cv2.COLOR_BGR2RGB)
            
            # Process segmentation
            image.flags.writeable = False
            results = selfie_segmentation.process(image)
            image.flags.writeable = True
            image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
            
            # Apply background or blur based on current settings
            output_image = apply_effects(image, results)
            
            # Calculate FPS (optional, for monitoring)
            curr_time = time.time()
            fps = 1 / (curr_time - prev_time) if (curr_time - prev_time) > 0 else 0
            prev_time = curr_time
            
            # Encode frame to JPEG
            ret, buffer = cv2.imencode('.jpg', output_image)
            frame = buffer.tobytes()
            
            # Yield frame in multipart format
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
    
    cap.release()


def apply_effects(image, segmentation_results):
    """
    Apply background replacement and/or blur effects to the image.
    
    Args:
        image (numpy.ndarray): Original camera frame
        segmentation_results: MediaPipe segmentation results
        
    Returns:
        numpy.ndarray: Processed image with effects applied
    """
    # Get the segmentation mask
    mask = segmentation_results.segmentation_mask
    
    # Apply morphological erosion to make the background fit tighter
    # This reduces gaps around hair and edges
    kernel = np.ones((7, 7), np.uint8)
    mask = cv2.erode(mask, kernel, iterations=1)
    
    # Create segmentation mask condition
    condition = np.stack((mask,) * 3, axis=-1) > SEGMENTATION_THRESHOLD
    
    # Case 1: Virtual background selected
    if selected_bg_index >= 0 and selected_bg_index < len(background_images):
        bg_image = background_images[selected_bg_index].copy()
        
        # Resize background to match camera frame
        bg_image = cv2.resize(bg_image, (image.shape[1], image.shape[0]))
        
        # Apply blur to background if enabled
        if apply_blur:
            bg_image = cv2.GaussianBlur(bg_image, BLUR_KERNEL_SIZE, 0)
        
        # Composite person over background
        output_image = np.where(condition, image, bg_image)
    
    # Case 2: No background selected
    else:
        if apply_blur:
            # Blur only the background, keep person sharp
            blurred_image = cv2.GaussianBlur(image, BLUR_KERNEL_SIZE, 0)
            output_image = np.where(condition, image, blurred_image)
        else:
            # Show original camera feed
            output_image = image
    
    return output_image


@app.route('/video_feed')
def video_feed():
    """
    Video streaming route.
    
    Returns:
        Response: Multipart video stream
    """
    return Response(gen_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')


# Load backgrounds on startup
load_backgrounds()

if __name__ == '__main__':
    print("Starting Virtual Background Generator...")
    print(f"Loaded {len(background_images)} background images")
    app.run(debug=True, port=5000)
