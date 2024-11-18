import React, { useState, useEffect, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import { useNavigate } from 'react-router-dom';
import '../styles/Global.css';
import '../styles/SessionPage.css';
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const SessionPage = () => {
  const [chartData, setChartData] = useState({
    labels: [],
    datasets: [
      {
        label: 'Attention Score',
        data: [],
        fill: false,
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1,
      },
    ],
  });

  const [movingAverage, setMovingAverage] = useState(0);
  const [attentionScores, setAttentionScores] = useState([]);
  const [session, setSession] = useState(null);
  const [socket, setSocket] = useState(null);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [summaries, setSummaries] = useState([]);
  const [processingStatus, setProcessingStatus] = useState('');
  
  const audioChunks = useRef([]);
  const lowAttentionPeriods = useRef([]);
  const apiUrl = process.env.REACT_APP_API_URL;

  useEffect(() => {
    if (processingStatus) {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [processingStatus]);
  const [lowAttentionScore, setLowAttentionScore] = useState(50);
  const [notificationInterval, setNotificationInterval] = useState(60); // seconds

  const notificationTimerRef = useRef(null);

  useEffect(() => {
    // Retrieve settings from localStorage
    const savedLowAttentionScore = localStorage.getItem('lowAttentionScore');
    const savedNotificationInterval = localStorage.getItem('frequency');

    if (savedLowAttentionScore) {
      setLowAttentionScore(Number(savedLowAttentionScore));
    }

    if (savedNotificationInterval) {
      setNotificationInterval(Number(savedNotificationInterval));
    }

    // Request notification permission
    if (Notification.permission !== 'granted') {
      Notification.requestPermission();
    }
  }, []);

  const calculateMovingAverage = (scores) => {
    if (!scores || scores.length === 0) return 0;
    const sum = scores.reduce((acc, curr) => acc + curr, 0);
    return (sum / scores.length).toFixed(2);
  };

  const handleConfirmStart = async () => {
    try {
      setIsLoading(true);
      audioChunks.current = [];
      lowAttentionPeriods.current = [];
      setSummaries([]);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.current.push(event.data);
        }
      };

      recorder.start(1000);
      setMediaRecorder(recorder);

      handleStartSession();
      setIsConfirmed(true);
      setSessionEnded(false);
    } catch (error) {
      console.error('Error starting session:', error);
      setIsLoading(false);
      setIsConfirmed(false);
    }
  };

  const handleStartSession = () => {
    setChartData({
      labels: [],
      datasets: [
        {
          label: 'Attention Score',
          data: [],
          fill: false,
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1,
        },
      ],
    });

    const requestOptions = {
      method: 'POST',
      redirect: 'follow',
    };

    fetch(`${apiUrl}/sessions`, requestOptions)
      .then((response) => response.text())
      .then((result) => {
        result = JSON.parse(result);
        console.log(result);
        setSession(result);
        startWebSocketConnection(result);
      })
      .catch((error) => console.error(error));
  };

  const handleStopSession = async () => {
    if (!socket || !mediaRecorder) return;

    try {
      setProcessingStatus('Stopping recording...');
      mediaRecorder.stop();

      // Clear the notification timer when session stops
      clearInterval(notificationTimerRef.current);

      await new Promise((resolve) => {
        mediaRecorder.onstop = async () => {
          if (audioChunks.current.length > 0 && lowAttentionPeriods.current.length > 0) {
            setProcessingStatus('Preparing audio data...');
            const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            formData.append('timestamps', JSON.stringify(lowAttentionPeriods.current));

            try {
              setProcessingStatus('Processing audio segments...');
              const response = await fetch(`${apiUrl}/process_audio`, {
                method: 'POST',
                body: formData,
              });

              if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
              }

              const data = await response.json();
              setProcessingStatus('');
              setSummaries(data.summaries || ['No insights available for this session.']);
            } catch (error) {
              console.error('Error processing audio:', error);
              setProcessingStatus('');
              setSummaries(['Failed to process audio. Please try again.']);
            }
          } else {
            setProcessingStatus('');
            setSummaries(['No attention drops detected during this session.']);
          }
          resolve();
        };
      });

      setMovingAverage(0);
      setAttentionScores([]);
      audioChunks.current = [];
      lowAttentionPeriods.current = [];

      fetch(`${apiUrl}/sessions/${session.session_id}`, { method: 'DELETE' })
        .then((response) => response.text())
        .then((result) => {
          console.log(result);
          socket.close();
          setSocket(null);
          setSession(null);
          setSessionEnded(true);
        })
        .catch((error) => console.error(error));
    } catch (error) {
      console.error('Error stopping session:', error);
      setProcessingStatus('');
      setSummaries(['An error occurred while ending the session.']);
    }
  };

  const startWebSocketConnection = (session) => {
    if (!session || !session.session_id) {
      console.error('Invalid session data');
      setIsLoading(false);
      return;
    }

    const wsUrl = process.env.REACT_APP_WS_URL;
    const newSocket = new WebSocket(`${wsUrl}/${session.session_id}`);
    setSocket(newSocket);

    newSocket.onopen = () => {
      console.log('WebSocket connection established');
      newSocket.send(
        JSON.stringify({ message: 'Session started', sessionId: session.session_id })
      );
    };

    newSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setIsLoading(false);
      console.log('Message from server: ', data);

      const attentionScore = data.attention_score;
      const timestamp = new Date(data.timestamp * 1000).toLocaleTimeString();

      // Check if attention score drops below threshold
      if (attentionScore > 0 && attentionScore < lowAttentionScore) {
        // Add to low attention periods
        lowAttentionPeriods.current.push({
          timestamp: data.timestamp,
          score: attentionScore,
        });
      }

      setAttentionScores((prev) => {
        const newScores = [...prev, attentionScore];
        const updatedScores = newScores.slice(-33);
        setMovingAverage(calculateMovingAverage(updatedScores));
        return updatedScores;
      });

      setChartData((prevData) => {
        const newLabels = [...prevData.labels, timestamp];
        const newData = [...prevData.datasets[0].data, attentionScore];

        if (newLabels.length > 20) {
          newLabels.shift();
          newData.shift();
        }

        return {
          labels: newLabels,
          datasets: [
            {
              ...prevData.datasets[0],
              data: newData,
            },
          ],
        };
      });
    };

    newSocket.onerror = (error) => {
      console.error('WebSocket error: ', error);
    };

    newSocket.onclose = () => {
      console.log('WebSocket connection closed');
    };

    // Start a timer to send notifications at the user-defined interval
    notificationTimerRef.current = setInterval(() => {
      if (lowAttentionPeriods.current.length > 0) {
        const lastAttentionDrop = lowAttentionPeriods.current[lowAttentionPeriods.current.length - 1];
        const score = lastAttentionDrop.score.toFixed(2);
        if (Notification.permission === 'granted') {
          new Notification('Low Attention Detected', {
            body: `Attention score dropped to ${score}%`,
          });
        }
      }
    }, notificationInterval * 1000); // Interval in milliseconds
  };

  return (
    <div className="create-ses-page" style={{ position: 'relative' }}>
      <div className="text-content">
        {!isConfirmed ? (
          <>
            <h1>Start A New Session</h1>
            <p>  Start a session to monitor your focus levels in real time and improve
          your productivity. Each session is designed to help you achieve
          better concentration and track your progress.</p>
            <button onClick={handleConfirmStart} className="start-session-button">
              Start Session
            </button>
          </>
        ) : (
          <div style={{ width: '100%', maxWidth: '800px', margin: '0 auto' }}>
            <h1>{Array.isArray(summaries) && summaries.length > 0 ? 'Session Summary' : 'Real-Time Attention Score'}</h1>
            
            <div className="graph-container" style={{ padding: '20px' }}>
              <div className="average-score" style={{ textAlign: 'center', marginBottom: '10px' }}>
                <h2>Average Attention Score: {movingAverage || 0}</h2>
              </div>
              
              <div style={{ 
                width: '600px',
                height: '300px',
                position: 'relative',
                margin: '0 auto'
              }}>
                {isLoading ? (
                  <div className="loading-container">
                    <div className="loading-spinner"></div>
                    <p>Initializing session...</p>
                  </div>
                ) : (
                  <Line 
                    data={chartData}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      scales: {
                        y: {
                          beginAtZero: true,
                          max: 100,
                          grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                          }
                        },
                        x: {
                          grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                          }
                        }
                      },
                      plugins: {
                        legend: {
                          labels: {
                            color: 'rgba(255, 255, 255, 0.7)'
                          }
                        }
                      }
                    }}
                  />
                )}
                {!sessionEnded && !processingStatus && (
                  <div style={{ 
                    textAlign: 'center',
                    marginTop: '20px'
                  }}>
                    <button
                      onClick={() => {
                        handleStopSession();
                        setProcessingStatus('Stopping recording...');
                      }}
                      className="start-session-button"
                      style={{ backgroundColor: '#dc2626' }}
                    >
                      Stop Session
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
              {processingStatus ? (
                <div className="summary-card" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '200px',
                  width: '100%',
                  marginTop: '20px',
                  textAlign: 'center',
                  marginLeft: 'auto',
                  marginRight: 'auto'
                }}>
                  <div className="loading-spinner" style={{ marginBottom: '20px' }}></div>
                  <p style={{ fontSize: '1.5em' }}>{processingStatus}</p>
                </div>
              ) : (
                <>
                {/* need summaries[0] to not be null or empty */}
                {Array.isArray(summaries) && summaries.length > 0 && summaries[0] && (
                <div className="summaries-container">
                  {summaries.map((summary, index) => (
                    <div key={index} className="summary-card">
                      <div className="card-section">
                        {/* <span className="topic-tag">Topic {index + 1}</span> */}
                        <h3>{summary.topic}</h3>
                      </div>
                      
                      <div className="card-section">
                        <p>{summary.summary}</p>
                      </div>

                      {Array.isArray(summary.key_points) && summary.key_points.length > 0 && (
                        <div className="card-section">
                          <ul>
                            {summary.key_points.map((point, idx) => (
                              <li key={idx}>{point}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="summary-metadata">
                        <span>Generated {new Date().toLocaleDateString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}


              </>
              )}
            </div>

            <div style={{ textAlign: 'center', marginTop: '20px' }}>



              {sessionEnded && (
                <button 
                  onClick={handleConfirmStart} 
                  className="start-session-button"
                  style={{ marginTop: '2rem' }}
                >
                  Start Another Session
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionPage;
