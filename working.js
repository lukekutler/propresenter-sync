lukekutler @Lukes-MBP - 177 proto % protoc--decode rv.data.Presentation./ propresenter.proto < /Users/lukekutler / Documents / ProPresenter / Libraries / Presentations / Transition.pro
application_info {
  platform: PLATFORM_MACOS
  platform_version {
    major_version: 15
    minor_version: 6
    patch_version: 1
  }
  application: APPLICATION_PROPRESENTER
  application_version {
    major_version: 19
    patch_version: 1
    build: "318767361"
  }
}
uuid {
  string: "2D129FC0-0B18-40FE-A055-E64B4CF0856A"
}
name: "Transition"
notes: "\342\235\226 Pray out of Worship\n\342\235\226 Dismiss LIFE Youth Jr. (6-8th Grades)\n\342\235\226 Next Step Story [Thompsons]\n\342\235\226 Ministry fair & Canvassing after service\n\342\235\226 Fall Fest Invites\n\342\235\226 Introduce Church News\n\342\232\221 CUE: \342\200\234LET\342\200\231S WATCH\342\200\235"
background {
  color {
    alpha: 1
  }
}
chord_chart {
  platform: PLATFORM_MACOS
}
arrangements {
  uuid {
    string: "9B096017-71CC-4E79-87DA-6106A5DFD1CE"
  }
  name: "Default"
  group_identifiers {
    string: "189B1A91-0D65-4923-B4D6-6C8CE0C5453C"
  }
}
cue_groups {
  group {
    uuid {
      string: "189B1A91-0D65-4923-B4D6-6C8CE0C5453C"
    }
    name: "Background & Lights"
    color {
      red: 0.054
      green: 0.211
      blue: 0.588
      alpha: 1
    }
    hotKey {
    }
    application_group_identifier {
      string: "7D3899C4-F79B-421A-B5BC-13F2C7C85CD6"
    }
  }
  cue_identifiers {
    string: "C3656949-6339-4D49-86AB-7E2030F4459B"
  }
  cue_identifiers {
    string: "A620CA04-6587-4E04-A5A4-F0AEE0EE4346"
  }
  cue_identifiers {
    string: "3DCC4ACF-5A27-4B56-88A7-08D8A15A3284"
  }
  cue_identifiers {
    string: "5706C082-4AE5-46B0-AD3A-BA9D52C2EB7C"
  }
  cue_identifiers {
    string: "E01277FE-1C36-42E2-9676-CCA083FD8D26"
  }
  cue_identifiers {
    string: "298FDB77-218A-4B94-A616-9914DC56DD1A"
  }
  cue_identifiers {
    string: "8AC92E26-2DFB-4F38-B785-A093D5D4BFA6"
  }
  cue_identifiers {
    string: "FFA5F680-F44D-4F3A-8CAB-EFD67C2F7BED"
  }
}
cues {
  uuid {
    string: "C3656949-6339-4D49-86AB-7E2030F4459B"
  }
  name: "Background & Lights"
  hot_key {
  }
  actions {
    uuid {
      string: "8FAC7194-D004-4AFD-9A3A-C75222B73A7E"
    }
    name: "Background & Lights"
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "FE16A5A1-DF19-4D12-AF43-F0B2D46D2A93"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "AF6FBFB3-8550-4E7E-AF2C-4360AD088451"
    }
    name: "Full Screen Media"
    isEnabled: true
    type: ACTION_TYPE_AUDIENCE_LOOK
    audience_look {
      identification {
        parameter_uuid {
          string: "33A07DC2-363E-4043-ADE7-1A019BC6D6E8"
        }
        parameter_name: "Full Screen Media"
      }
    }
  }
  actions {
    uuid {
      string: "F13CAC83-CF40-4AF2-9FB3-DCF4BE5F1BE7"
    }
    name: "Stage"
    isEnabled: true
    type: ACTION_TYPE_STAGE_LAYOUT
    stage {
      stage_screen_assignments {
        screen {
          parameter_uuid {
            string: "FDF19162-971E-4F77-B31D-7912EE92B720"
          }
          parameter_name: "Stage Display"
        }
        layout {
          parameter_uuid {
            string: "CF16CBC4-ECC5-4BB8-9AC8-0C772F9F9A21"
          }
          parameter_name: "Notes"
        }
      }
      stage_screen_assignments {
        screen {
          parameter_uuid {
            string: "F7C1EB33-B379-4090-ADE1-DC32694FB66A"
          }
          parameter_name: "Remote Screens"
        }
        layout {
          parameter_uuid {
            string: "CF16CBC4-ECC5-4BB8-9AC8-0C772F9F9A21"
          }
          parameter_name: "Notes"
        }
      }
    }
  }
  actions {
    uuid {
      string: "DC2CE33B-EE05-4560-A844-7CA1450F0BB9"
    }
    name: "Countdown 240s"
    isEnabled: true
    type: ACTION_TYPE_TIMER
    timer {
      action_type: ACTION_RESET_AND_START
      timer_identification {
        parameter_uuid {
          string: "BEAE2AF5-12B4-4C82-8CE5-8C41B5043275"
        }
        parameter_name: "Service Item Timer"
      }
      timer_configuration {
        countdown {
          duration: 240
        }
      }
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "A620CA04-6587-4E04-A5A4-F0AEE0EE4346"
  }
  name: "Dismiss LIFE Youth Jr. (6-8th Grades)"
  hot_key {
  }
  actions {
    uuid {
      string: "A1107D74-B29D-416F-B33C-00657BD6C223"
    }
    name: "Dismiss LIFE Youth Jr. (6-8th Grades)"
    label {
      text: "Dismiss LIFE Youth Jr. (6-8th Grades)"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "694DF76F-0693-405C-ABE9-A82DFF195B38"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "9DF9B71C-0BFD-459E-A844-C660AE1D308F"
    }
    name: "LIFE Youth Jr.jpg"
    label {
      text: "LIFE Youth Jr.jpg"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_MEDIA
    media {
      element {
        uuid {
          string: "74CD8E47-48DB-4A5B-B456-17A923E10038"
        }
        url {
          absolute_string: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/LIFE%20Youth%20Jr.jpg"
          platform: PLATFORM_MACOS
          local {
            root: ROOT_USER_DOCUMENTS
            path: "Word Of Life/Titles/LIFE Youth Jr.jpg"
          }
        }
        metadata {
          format: "JPG"
        }
        image {
          drawing {
            natural_size {
              width: 3840
              height: 2160
            }
            custom_image_bounds {
              origin {
              }
              size {
                width: 3840
                height: 2160
              }
            }
            crop_insets {
            }
            15: 1
          }
          2 {
            1 {
              1: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/LIFE%20Youth%20Jr.jpg"
              3: 1
              4 {
                1: 3
                2: "Word Of Life/Titles/LIFE Youth Jr.jpg"
              }
            }
          }
        }
      }
      audio {
      }
      layer_type: LAYER_TYPE_FOREGROUND
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "3DCC4ACF-5A27-4B56-88A7-08D8A15A3284"
  }
  name: "CLEAR"
  hot_key {
  }
  actions {
    uuid {
      string: "0B7851CD-D73A-4A75-8D6A-DB0161FF88E8"
    }
    name: "CLEAR"
    label {
      text: "CLEAR"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "C04EA7A4-0DBC-4875-A0F6-AFAF1B6592F2"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "66EF332D-4F81-4CFF-8FEC-C00FE46AA491"
    }
    name: "Clear"
    isEnabled: true
    type: ACTION_TYPE_CLEAR
    clear {
      target_layer: CLEAR_TARGET_LAYER_BACKGROUND
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "E01277FE-1C36-42E2-9676-CCA083FD8D26"
  }
  name: "CLEAR"
  hot_key {
  }
  actions {
    uuid {
      string: "144DA0DC-30AC-4CF0-8DF9-6F0517EFADBB"
    }
    name: "CLEAR"
    label {
      text: "CLEAR"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "99A63E1A-0831-4EA4-8172-4CA24D3E319F"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "DC22587B-FD6D-408E-A1B2-13B7FEAE16E7"
    }
    name: "Clear"
    isEnabled: true
    type: ACTION_TYPE_CLEAR
    clear {
      target_layer: CLEAR_TARGET_LAYER_BACKGROUND
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "8AC92E26-2DFB-4F38-B785-A093D5D4BFA6"
  }
  name: "CLEAR"
  hot_key {
  }
  actions {
    uuid {
      string: "F71F53C1-2053-4D97-A6C0-2FFDC959DD27"
    }
    name: "CLEAR"
    label {
      text: "CLEAR"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "6B7EA425-C09B-45F0-ABDF-F6B161E4F9D6"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "87E0DBE0-F08A-4ED8-BBA0-789786E48AB3"
    }
    name: "Clear"
    isEnabled: true
    type: ACTION_TYPE_CLEAR
    clear {
      target_layer: CLEAR_TARGET_LAYER_BACKGROUND
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "FFA5F680-F44D-4F3A-8CAB-EFD67C2F7BED"
  }
  name: "Fall Fest Invites"
  hot_key {
  }
  actions {
    uuid {
      string: "CE99968C-93B6-49D2-97A4-D3CDDFF4B176"
    }
    name: "Fall Fest Invites"
    label {
      text: "Fall Fest Invites"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "1E948F4E-34EE-4751-A44D-48003949C303"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "72D25AA8-6B6C-4468-8EB5-4FA284ACD181"
    }
    name: "Fall Fest.jpg"
    label {
      text: "Fall Fest.jpg"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_MEDIA
    media {
      element {
        uuid {
          string: "9285808A-C7D4-46D9-89DF-94E5CAE4B50A"
        }
        url {
          absolute_string: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/Fall%20Fest.jpg"
          platform: PLATFORM_MACOS
          local {
            root: ROOT_USER_DOCUMENTS
            path: "Word Of Life/Titles/Fall Fest.jpg"
          }
        }
        metadata {
          format: "JPG"
        }
        image {
          drawing {
            natural_size {
              width: 1920
              height: 1080
            }
            custom_image_bounds {
              origin {
              }
              size {
                width: 1920
                height: 1080
              }
            }
            crop_insets {
            }
            15: 1
          }
          2 {
            1 {
              1: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/Fall%20Fest.jpg"
              3: 1
              4 {
                1: 3
                2: "Word Of Life/Titles/Fall Fest.jpg"
              }
            }
          }
        }
      }
      audio {
      }
      layer_type: LAYER_TYPE_FOREGROUND
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "5706C082-4AE5-46B0-AD3A-BA9D52C2EB7C"
  }
  name: "Next Step Story [Thompsons]"
  hot_key {
  }
  actions {
    uuid {
      string: "A73AC030-40DD-40D0-8D31-A079DA37ED14"
    }
    name: "Next Step Story [Thompsons]"
    label {
      text: "Next Step Story [Thompsons]"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "154BC2EA-C628-4834-AD07-F5C96B981D51"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "FFA5ECCA-E173-496B-89AF-A7773DD799AB"
    }
    name: "Next Steps.jpg"
    label {
      text: "Next Steps.jpg"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_MEDIA
    media {
      element {
        uuid {
          string: "321C1DBA-92A7-4F9D-BB7E-99C4A65C69D1"
        }
        url {
          absolute_string: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/Next%20Steps.jpg"
          platform: PLATFORM_MACOS
          local {
            root: ROOT_USER_DOCUMENTS
            path: "Word Of Life/Titles/Next Steps.jpg"
          }
        }
        metadata {
          format: "JPG"
        }
        image {
          drawing {
            natural_size {
              width: 3840
              height: 2160
            }
            custom_image_bounds {
              origin {
              }
              size {
                width: 3840
                height: 2160
              }
            }
            crop_insets {
            }
            15: 1
          }
          2 {
            1 {
              1: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/Next%20Steps.jpg"
              3: 1
              4 {
                1: 3
                2: "Word Of Life/Titles/Next Steps.jpg"
              }
            }
          }
        }
      }
      audio {
      }
      layer_type: LAYER_TYPE_FOREGROUND
    }
  }
  isEnabled: true
}
cues {
  uuid {
    string: "298FDB77-218A-4B94-A616-9914DC56DD1A"
  }
  name: "Ministry fair & Canvassing after service"
  hot_key {
  }
  actions {
    uuid {
      string: "69D63D52-AF40-4C23-BDDA-E8BBFDF98DD4"
    }
    name: "Ministry fair & Canvassing after service"
    label {
      text: "Ministry fair & Canvassing after service"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_PRESENTATION_SLIDE
    slide {
      presentation {
        base_slide {
          background_color {
          }
          size {
            width: 1920
            height: 1080
          }
          uuid {
            string: "3D90D266-81B6-4937-BAD3-46F1B52CEFBC"
          }
        }
        chord_chart {
          platform: PLATFORM_MACOS
        }
      }
    }
  }
  actions {
    uuid {
      string: "5CEF3335-489D-4DD2-94DD-724DB9CD7BD2"
    }
    name: "2025.09.28-Ministry Fair.jpg"
    label {
      text: "2025.09.28-Ministry Fair.jpg"
      color {
        red: 0.054
        green: 0.211
        blue: 0.588
        alpha: 1
      }
    }
    isEnabled: true
    type: ACTION_TYPE_MEDIA
    media {
      element {
        uuid {
          string: "68DB6E3D-A9D2-424E-9C86-38DA7227D5FA"
        }
        url {
          absolute_string: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/2025.09.28-Ministry%20Fair.jpg"
          platform: PLATFORM_MACOS
          local {
            root: ROOT_USER_DOCUMENTS
            path: "Word Of Life/Titles/2025.09.28-Ministry Fair.jpg"
          }
        }
        metadata {
          format: "JPG"
        }
        image {
          drawing {
            natural_size {
              width: 1920
              height: 1080
            }
            custom_image_bounds {
              origin {
              }
              size {
                width: 1920
                height: 1080
              }
            }
            crop_insets {
            }
            15: 1
          }
          2 {
            1 {
              1: "file:///Users/lukekutler/Documents/Word%20Of%20Life/Titles/2025.09.28-Ministry%20Fair.jpg"
              3: 1
              4 {
                1: 3
                2: "Word Of Life/Titles/2025.09.28-Ministry Fair.jpg"
              }
            }
          }
        }
      }
      audio {
      }
      layer_type: LAYER_TYPE_FOREGROUND
    }
  }
  isEnabled: true
}
ccli {
}
timeline {
  duration: 300
}
lukekutler @Lukes-MBP - 177 proto % 
